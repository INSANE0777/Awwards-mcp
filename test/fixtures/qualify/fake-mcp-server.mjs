// Minimal JSON-RPC stdio server for the qualification client tests. It never
// touches the network or the product build.
process.stdin.setEncoding("utf8");
let buffer = "";
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

if (process.env.FAKE_NOISE === "1") process.stdout.write("noise-before-response\n");

process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\n");
    if (index < 0) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === "") continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof message.id === "undefined") continue;
    const id = process.env.FAKE_BAD_ID === "1" ? message.id + 1 : message.id;
    if (process.env.FAKE_ERROR === "1") {
      send({ jsonrpc: "2.0", id, error: { code: -32000, message: "boom" } });
      continue;
    }
    const result =
      message.method === "tools/list"
        ? { tools: [{ name: "fake_tool" }] }
        : { method: message.method, params: message.params };
    send({ jsonrpc: "2.0", id, result });
    if (process.env.FAKE_DUP_ID === "1") send({ jsonrpc: "2.0", id, result });
  }
});

process.stdin.on("end", () => process.exit(0));
