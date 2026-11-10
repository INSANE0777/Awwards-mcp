import { ATLAS_SCHEMA_ID, type AtlasEnvelope } from "./tool-contracts.js";
import type { EvidenceCoverage } from "./types.js";

export const UNKNOWN_COVERAGE: EvidenceCoverage = {
  status: "unknown",
  collected: 0,
  excluded: 0,
  limitations: [],
};

export function atlasSuccess<T>(
  operation: string,
  status: AtlasEnvelope<T>["status"],
  data: T,
  coverage: EvidenceCoverage,
  warnings: string[] = [],
): AtlasEnvelope<T> {
  return {
    schemaVersion: ATLAS_SCHEMA_ID,
    operation,
    status,
    data,
    coverage,
    warnings: warnings.slice(0, 64),
    error: null,
  };
}

export function atlasFailure<T>(
  operation: string,
  code: string,
  message: string,
  retryable: boolean,
  status: "error" | "blocked" | "inconclusive" = "error",
): AtlasEnvelope<T> {
  return {
    schemaVersion: ATLAS_SCHEMA_ID,
    operation,
    status,
    data: null,
    coverage: UNKNOWN_COVERAGE,
    warnings: [],
    error: { code, message: message.slice(0, 2000), retryable },
  };
}

// Path runs end at a character that cannot continue them; whitespace can
// (a Windows path may contain spaces), so an unquoted path consumes to the
// quote or line end. Redacting surrounding prose is the safe direction.
const PATH_STOP = new Set(["\n", "\r", '"', "'", "`", "<", ">", "|"]);
const PATH_QUOTES = new Set(['"', "'", "`"]);
const WORD_CHAR = /[A-Za-z0-9_]/;
const PATH_CONTINUES = /[\p{L}\p{N}_]/u;

// A quote ends a path only when what follows cannot continue one (whitespace,
// punctuation or end of string): an embedded apostrophe such as O'Brien is
// part of the path, and over-redacting the rest of the line is the safe direction.
function quotedPathContinues(value: string, index: number, quote: string): boolean {
  const char = value[index]!;
  if (char === "\n" || char === "\r") return false;
  if (char !== quote) return true;
  const next = value[index + 1];
  return next !== undefined && PATH_CONTINUES.test(next);
}

function pathStartLength(text: string, index: number): number {
  const char = text[index]!;
  const next = text[index + 1] ?? "";
  const after = text[index + 2] ?? "";
  const prev = index > 0 ? text[index - 1]! : "";
  const wordBefore = WORD_CHAR.test(prev);
  if (/[A-Za-z]/.test(char) && next === ":" && (after === "\\" || after === "/")) {
    return wordBefore ? 0 : 3;
  }
  if (char === "\\") {
    if (next === "\\") return wordBefore ? 0 : 2;
    // A cache-root remainder such as `<cache>\db.sqlite` must not survive.
    return wordBefore ? 0 : 1;
  }
  // A single leading slash, but not a URL's `//`, `read/write` or `../`.
  if (char === "/" && next !== "/" && !wordBefore && prev !== "/" && prev !== ":" && prev !== ".") {
    return 1;
  }
  if ((char === "." || char === "~") && (next === "\\" || next === "/")) {
    return wordBefore ? 0 : 2;
  }
  if (char === "." && next === "." && (after === "\\" || after === "/")) return 3;
  return 0;
}

/** Redact POSIX, Windows and mixed-separator paths, quoted or not. */
function redactPaths(value: string): string {
  let out = "";
  let index = 0;
  while (index < value.length) {
    const start = pathStartLength(value, index);
    if (start === 0) {
      out += value[index];
      index += 1;
      continue;
    }
    let end = index + start;
    const body = end;
    // A path opened by a quote ends only at that same quote (or a newline):
    // pipes and angle brackets are legal inside a quoted POSIX filename.
    const quote = index > 0 && PATH_QUOTES.has(value[index - 1]!) ? value[index - 1] : null;
    while (
      end < value.length &&
      (quote ? quotedPathContinues(value, end, quote) : !PATH_STOP.has(value[end]!))
    ) {
      end += 1;
    }
    // A lone separator or "/ word" is prose, not a path.
    if (end === body || /\s/.test(value[body]!)) {
      out += value[index];
      index += 1;
      continue;
    }
    while (end > body && /\s/.test(value[end - 1]!)) end -= 1;
    out += "<path>";
    index = end;
  }
  return out;
}

/** Never expose an absolute filesystem path or a stack in a tool error. */
export function safeMessage(message: string, cacheRoot?: string): string {
  let value = message;
  if (cacheRoot) value = value.split(cacheRoot).join("<cache>");
  return redactPaths(value).slice(0, 2000);
}
