// Minimal MCP stdio client for qualification. It records every stdout byte
// that is not a well-formed JSON-RPC response, every wrong/duplicate/unknown
// response id, blocked egress lines and shutdown problems, so a run can only
// pass with a clean channel.
import { spawn, spawnSync } from "node:child_process";
import { GUARD_MARKER } from "../egress-guard-marker.cjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startMcpClient({
  command,
  args = [],
  cwd,
  env,
  requestTimeoutMs = 30_000,
  stopTimeoutMs = 5_000,
  label = "mcp",
}) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    // A process group lets stop() reap Chromium grandchildren too. Windows
    // uses taskkill /T instead.
    detached: process.platform !== "win32",
  });

  const pending = new Map();
  const noise = [];
  const problems = [];
  const responses = [];
  let buffer = "";
  let stderr = "";
  let nextId = 1;
  let exit = null;
  let spawnError = null;
  let closed = false;

  const exitPromise = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      exit = { code, signal };
      resolve(exit);
    });
  });
  const closePromise = new Promise((resolve) => {
    child.once("close", () => {
      closed = true;
      resolve();
    });
  });
  child.once("error", (error) => {
    spawnError = error;
    problems.push(`${label}: child error: ${error.message}`);
  });

  const ingest = (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      noise.push(line);
      return;
    }
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") {
      noise.push(line);
      return;
    }
    if (typeof message.id === "undefined") {
      problems.push(`${label}: unexpected server notification on stdout: ${line.slice(0, 120)}`);
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) {
      const duplicate = responses.some((entry) => entry.id === message.id);
      problems.push(
        `${label}: ${duplicate ? "duplicate" : "unknown"} response id ${message.id}: ${line.slice(0, 120)}`,
      );
      return;
    }
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    responses.push(message);
    waiter.resolve(message);
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line !== "") ingest(line);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  function request(method, params, timeoutMs = requestTimeoutMs) {
    const id = nextId++;
    const message = { jsonrpc: "2.0", id, method };
    if (params !== undefined) message.params = params;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${label}: ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer, method });
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error(`${label}: ${method} write failed: ${error.message}`));
      });
    });
  }

  async function result(method, params, timeoutMs) {
    const message = await request(method, params, timeoutMs);
    if (message.error) {
      throw new Error(`${label}: ${method}: ${message.error.message ?? JSON.stringify(message.error)}`);
    }
    return message.result;
  }

  function notify(method, params) {
    const message = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function callTool(name, args) {
    return request("tools/call", { name, arguments: args });
  }

  function guardBlocks() {
    return stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.includes(GUARD_MARKER));
  }

  function audit() {
    const combined = [...problems];
    if (buffer.length > 0) combined.push(`${label}: trailing partial stdout: ${buffer.slice(0, 120)}`);
    if (pending.size > 0) combined.push(`${label}: ${pending.size} request(s) still pending at shutdown`);
    if (!closed) combined.push(`${label}: stdio did not close`);
    if (spawnError) combined.push(`${label}: spawn failed: ${spawnError.message}`);
    const blocks = guardBlocks();
    if (blocks.length > 0) combined.push(`${label}: blocked egress: ${blocks.join(" | ")}`);
    return {
      label,
      ok: combined.length === 0 && noise.length === 0,
      noise: [...noise],
      problems: combined,
      guardBlocks: blocks,
      stderr,
      exit,
      responses,
    };
  }

  async function stop() {
    if (pending.size > 0) {
      for (const [id, waiter] of pending) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`${label}: ${waiter.method} aborted during shutdown`));
        pending.delete(id);
      }
    }
    const killTree = (signal) => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        return;
      }
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* already gone */
        }
      }
    };
    if (spawnError) {
      await Promise.race([closePromise, delay(stopTimeoutMs)]);
      return audit();
    }
    if (!exit) {
      killTree("SIGTERM");
      let terminated = await Promise.race([exitPromise.then(() => true), delay(stopTimeoutMs).then(() => false)]);
      if (!terminated) {
        killTree("SIGKILL");
        terminated = await Promise.race([exitPromise.then(() => true), delay(3_000).then(() => false)]);
      }
      if (!terminated) problems.push(`${label}: child ${child.pid} did not terminate`);
    }
    await Promise.race([closePromise, delay(2_000)]);
    return audit();
  }

  return {
    pid: child.pid,
    request,
    result,
    notify,
    callTool,
    stop,
    audit,
  };
}
