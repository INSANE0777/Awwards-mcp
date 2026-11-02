// Tool registration guard: profile filtering, per-call debug memory lines and
// a response-byte ceiling. Kept out of the server factory so tests can
// exercise it without starting the stdio server.

// The 13 tool core an agent needs for the capture -> analyze -> build -> verify
// loop. AWWWARDS_MCP_PROFILE=core registers only these; default full has all 39.
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

// The full serialized result: text, inline image data and structuredContent.
// isError and other result keys are part of it too, so no field can bypass the
// ceiling by living outside `content`.
function resultBytes(result: unknown): number {
  if (!result || typeof result !== "object") return 0;
  try {
    return Buffer.byteLength(JSON.stringify(result) ?? "", "utf8");
  } catch {
    return 0;
  }
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
        const bytes = resultBytes(result);
        if (bytes > limit && result && typeof result === "object") {
          const record = result as Record<string, unknown>;
          // A structured success cannot survive truncation: keep the notice
          // text but drop the payload and mark the result as an error so the
          // SDK's output-schema validation is skipped instead of failing on a
          // missing structuredContent.
          const { structuredContent } = record;
          const wasError = record.isError === true || structuredContent !== undefined;
          return {
            ...(wasError ? { isError: true } : {}),
            content: [
              {
                type: "text",
                text: JSON.stringify({ truncated: true, tool: name, bytes, limit, note: note() }),
              },
            ],
          };
        }
        // An isError result must not carry a structured success payload.
        if (result && typeof result === "object") {
          const record = result as Record<string, unknown>;
          if (record.isError === true && record.structuredContent !== undefined) {
            const { structuredContent: _drop, ...rest } = record;
            return rest;
          }
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
