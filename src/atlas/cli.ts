export type AtlasCliCommand =
  | { kind: "import" }
  | { kind: "error"; message: string };

export const ATLAS_CLI_USAGE = "awwwards-index --atlas import";

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
    return { kind: "error", message: `specify --atlas once. usage: ${ATLAS_CLI_USAGE}` };
  }

  const { value, index } = atlasIndexes[0]!;
  if (value !== "--atlas" && !value.startsWith("--atlas=")) {
    return {
      kind: "error",
      message: `unsupported --atlas form "${value}". usage: ${ATLAS_CLI_USAGE}`,
    };
  }
  const expectedLength = value === "--atlas" ? index + 2 : index + 1;
  if (argv.length !== expectedLength || index !== 0) {
    return { kind: "error", message: `--atlas does not accept extra arguments. usage: ${ATLAS_CLI_USAGE}` };
  }

  const action = value === "--atlas" ? argv[1] : value.slice("--atlas=".length);
  if (action === "import") return { kind: "import" };
  return {
    kind: "error",
    message: `unsupported --atlas action "${action ?? ""}"; expected "import". usage: ${ATLAS_CLI_USAGE}`,
  };
}
