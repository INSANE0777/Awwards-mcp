export type AtlasViewportChoice = "desktop" | "mobile" | "both";

export type AtlasCliCommand =
  | { kind: "import" }
  | { kind: "capture"; slug: string; path: string; viewport: AtlasViewportChoice }
  | { kind: "reindex" }
  | { kind: "verify" }
  | { kind: "prune"; olderThanDays: number; apply: boolean }
  | { kind: "error"; message: string };

export const ATLAS_CLI_USAGE = [
  "awwwards-index --atlas import",
  "awwwards-index --atlas capture --slug <slug> [--path /] --viewport desktop|mobile|both",
  "awwwards-index --atlas reindex",
  "awwwards-index --atlas verify",
  "awwwards-index --atlas prune --older-than-days <N> [--apply]",
].join("\n");

const SLUG = /^[\w-]+$/;
const DAYS = /^[1-9]\d*$/;

type OptionSpec = ReadonlyMap<string, "value" | "flag">;

function fail(message: string): AtlasCliCommand {
  return { kind: "error", message: `${message}. usage: ${ATLAS_CLI_USAGE}` };
}

function readOptions(
  rest: readonly string[],
  spec: OptionSpec,
): { ok: true; values: Map<string, string>; flags: Set<string> } | { ok: false; message: string } {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (!token.startsWith("--")) {
      return { ok: false, message: `unexpected argument "${token}"` };
    }
    const equals = token.indexOf("=");
    const name = equals === -1 ? token : token.slice(0, equals);
    const kind = spec.get(name);
    if (!kind) return { ok: false, message: `unsupported option "${name}"` };
    if (kind === "flag") {
      if (equals !== -1) return { ok: false, message: `${name} does not take a value` };
      if (flags.has(name)) return { ok: false, message: `${name} may be specified once` };
      flags.add(name);
      continue;
    }
    if (values.has(name)) return { ok: false, message: `${name} may be specified once` };
    let value: string | undefined;
    if (equals !== -1) {
      value = token.slice(equals + 1);
    } else {
      const next = rest[index + 1];
      if (next === undefined || next.startsWith("--")) {
        return { ok: false, message: `${name} requires a value` };
      }
      value = next;
      index += 1;
    }
    if (value.length === 0) return { ok: false, message: `${name} requires a value` };
    values.set(name, value);
  }
  return { ok: true, values, flags };
}

function parseCapture(rest: readonly string[]): AtlasCliCommand {
  const options = readOptions(
    rest,
    new Map([
      ["--slug", "value"],
      ["--path", "value"],
      ["--viewport", "value"],
    ]),
  );
  if (!options.ok) return fail(options.message);
  const slug = options.values.get("--slug");
  const viewport = options.values.get("--viewport");
  const path = options.values.get("--path") ?? "/";
  if (!slug) return fail("capture requires --slug");
  if (slug.length > 200 || !SLUG.test(slug)) {
    return fail("--slug must be 1-200 letters, digits, underscores or hyphens");
  }
  if (!viewport) return fail("capture requires --viewport desktop|mobile|both");
  if (viewport !== "desktop" && viewport !== "mobile" && viewport !== "both") {
    return fail("--viewport must be desktop, mobile or both");
  }
  if (
    path.length > 2000 ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("?") ||
    path.includes("#")
  ) {
    return fail("--path must start with one slash and may not contain a query or fragment");
  }
  return { kind: "capture", slug, path, viewport };
}

function parsePrune(rest: readonly string[]): AtlasCliCommand {
  const options = readOptions(
    rest,
    new Map([
      ["--older-than-days", "value"],
      ["--apply", "flag"],
    ]),
  );
  if (!options.ok) return fail(options.message);
  const raw = options.values.get("--older-than-days");
  if (!raw) return fail("prune requires --older-than-days <N>");
  if (!DAYS.test(raw)) return fail("--older-than-days must be a positive integer");
  const olderThanDays = Number(raw);
  if (!Number.isSafeInteger(olderThanDays)) {
    return fail("--older-than-days must be a positive integer");
  }
  return { kind: "prune", olderThanDays, apply: options.flags.has("--apply") };
}

/**
 * Pure `--atlas` argument parser. Every accepted form is explicit; anything
 * else is an error, never a silent fall-through to the legacy crawler.
 */
export function parseAtlasCliArgs(argv: readonly string[]): AtlasCliCommand | null {
  const atlasIndexes = argv
    .map((value, index) => ({ value, index }))
    .filter(({ value }) => value.startsWith("--atlas"));
  if (atlasIndexes.length === 0) return null;
  if (atlasIndexes.length > 1) {
    return fail("specify --atlas once");
  }

  const { value, index } = atlasIndexes[0]!;
  if (value !== "--atlas" && !value.startsWith("--atlas=")) {
    return fail(`unsupported --atlas form "${value}"`);
  }
  if (index !== 0) {
    return fail("--atlas actions cannot be combined with the site crawl");
  }

  const inline = value === "--atlas" ? null : value.slice("--atlas=".length);
  const action = inline ?? argv[1];
  const rest = inline === null ? argv.slice(2) : argv.slice(1);
  if (!action) return fail("--atlas requires an action");

  switch (action) {
    case "import":
      return rest.length === 0 ? { kind: "import" } : fail("import does not accept options");
    case "capture":
      return parseCapture(rest);
    case "reindex":
      return rest.length === 0 ? { kind: "reindex" } : fail("reindex does not accept options");
    case "verify":
      return rest.length === 0 ? { kind: "verify" } : fail("verify does not accept options");
    case "prune":
      return parsePrune(rest);
    default:
      return fail(`unsupported --atlas action "${action}"`);
  }
}
