import { describe, expect, it } from "vitest";
import { createServer, SERVER_INSTRUCTIONS } from "../src/server-instance.js";

// McpServer keeps its registry on a private field; reading it is the only
// way to assert registrations without opening a transport.
const toolNames = (server: unknown): string[] =>
  Object.keys((server as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {});

describe("server factory", () => {
  it("returns a distinct server with 41 registrations and instructions per call", () => {
    const savedProfile = process.env.AWWWARDS_MCP_PROFILE;
    const savedLegacy = process.env.AWARDS_MCP_PROFILE;
    delete process.env.AWWWARDS_MCP_PROFILE;
    delete process.env.AWARDS_MCP_PROFILE;
    try {
      const handlers = {} as any;
      const first = createServer({ handlers, version: "0.0.0-test" });
      const second = createServer({ handlers, version: "0.0.0-test" });

      expect(second).not.toBe(first);
      expect(toolNames(first)).toHaveLength(41);
      expect(toolNames(second)).toHaveLength(41);
      expect(toolNames(second)).toEqual(toolNames(first));

      // Instructions live on the underlying protocol Server, not McpServer.
      expect((first as any).server._instructions).toBe(SERVER_INSTRUCTIONS);
      for (const word of [
        "search_sites",
        "verify_build",
        "AWWWARDS_MCP_PROFILE",
        "hand-rebuild",
        "build_pose_stub",
        "CDP",
        "untrusted data",
      ]) {
        expect(SERVER_INSTRUCTIONS, word).toContain(word);
      }
    } finally {
      if (savedProfile === undefined) delete process.env.AWWWARDS_MCP_PROFILE;
      else process.env.AWWWARDS_MCP_PROFILE = savedProfile;
      if (savedLegacy === undefined) delete process.env.AWARDS_MCP_PROFILE;
      else process.env.AWARDS_MCP_PROFILE = savedLegacy;
    }
  });
});
