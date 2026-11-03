// Tool registration guard: profile filtering, per-call debug memory lines and
// a response-byte ceiling. Kept out of the server factory so tests can
// exercise it without starting the stdio server.

// The 13 tool core an agent needs for the capture -> analyze -> build -> verify
// loop. AWWWARDS_MCP_PROFILE=core registers only these; default full has all 41.
export const CORE_TOOL_NAMES: readonly string[] = [
  "search_sites",
  "get_site_details",
  "analyze_page_structure",
  "analyze_scroll_map",
  "capture_component",
  "verify_build",
  "build_project",
  "get_motion_dna",
  "analyze_stack",
  "capture_live_site",
  "get_annual_categories",
  "get_annual_nominees",
  "get_collections",
];

export const DEFAULT_MAX_RESPONSE_BYTES = 32_000_000;

// Canonical AWWWARDS_MCP_* names, with the one-release AWARDS_MCP_* fallback
// from v1.14.0. The new value wins even when set to an empty string.
export function envValue(env: NodeJS.ProcessEnv, suffix: string): string | undefined {
  return env[`AWWWARDS_MCP_${suffix}`] ?? env[`AWARDS_MCP_${suffix}`];
}

export function isCoreTool(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (envValue(env, "PROFILE") !== "core") return true;
  return CORE_TOOL_NAMES.includes(name);
}

function maxResponseBytes(env: NodeJS.ProcessEnv): number {
  const raw = Number(envValue(env, "MAX_RESPONSE_BYTES"));
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : DEFAULT_MAX_RESPONSE_BYTES;
}

// text + inline image data only; isError and other result keys are not payload.
function payloadBytes(result: unknown): number {
  if (!result || typeof result !== "object") return 0;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return 0;
  let bytes = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const { type, text, data } = block as { type?: unknown; text?: unknown; data?: unknown };
    if (type === "text" && typeof text === "string") bytes += Buffer.byteLength(text, "utf8");
    else if (type === "image" && typeof data === "string") bytes += Buffer.byteLength(data, "utf8");
  }
  return bytes;
}

const note = (): string =>
  "Response exceeded AWWWARDS_MCP_MAX_RESPONSE_BYTES; narrow the request or raise the limit.";

type ServerLike = {
  registerTool: (...args: any[]) => unknown;
};

// Registers through server.registerTool (v2 has no server.tool). In core
// profile a non-core name is silently skipped. The final function argument
// (the handler) is wrapped: response size is enforced, and
// AWWWARDS_MCP_DEBUG_MEMORY=1 emits one JSON line per call on stderr (never
// stdout — stdout is the JSON-RPC channel).
export function registerGuarded(
  server: ServerLike,
  method: "registerTool",
  args: any[],
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = (line) => console.error(line),
): void {
  const name = String(args[0]);
  if (!isCoreTool(name, env)) return;

  const last = args.length - 1;
  const handler = args[last];
  if (typeof handler === "function") {
    const limit = maxResponseBytes(env);
    const debugMemory = envValue(env, "DEBUG_MEMORY") === "1";
    args[last] = async (...callArgs: unknown[]) => {
      const started = performance.now();
      try {
        const result = await handler(...callArgs);
        const bytes = payloadBytes(result);
        if (bytes > limit && result && typeof result === "object") {
          // Keep isError, structuredContent and every other non-content field;
          // only the payload is replaced by the truncation notice.
          return {
            ...(result as Record<string, unknown>),
            content: [
              {
                type: "text",
                text: JSON.stringify({ truncated: true, tool: name, bytes, limit, note: note() }),
              },
            ],
          };
        }
        return result;
      } finally {
        if (debugMemory) {
          const mem = process.memoryUsage();
          log(
            JSON.stringify({
              tool: name,
              durationMs: Math.round(performance.now() - started),
              rss: mem.rss,
              heapUsed: mem.heapUsed,
              heapTotal: mem.heapTotal,
              external: mem.external,
            }),
          );
        }
      }
    };
  }

  server.registerTool(...args);
}
