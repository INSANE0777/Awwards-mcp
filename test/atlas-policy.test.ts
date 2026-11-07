import { describe, expect, it } from "vitest";
import {
  checkAtlasRedirect,
  checkAtlasRobots,
  isMutatingMethod,
  parseAtlasRobots,
  robotsAllows,
} from "../src/atlas/policy.js";
import { createSceneUrlGate } from "../src/scene-capture.js";

describe("Atlas capture policy", () => {
  it("merges repeated matching groups and decodes encoded robots paths", () => {
    const policy = parseAtlasRobots(
      [
        "User-agent: AwwwardsAtlas",
        "Disallow: /private",
        "",
        "User-agent: AwwwardsAtlas",
        "Allow: /private/public",
      ].join("\n"),
    );
    expect(robotsAllows("/private/secret", policy)).toBe(false);
    expect(robotsAllows("/private/public/page", policy)).toBe(true);
    expect(robotsAllows("/priv%61te/secret", policy)).toBe(false);
  });

  it("preserves repeated slashes for robots matching", () => {
    const policy = parseAtlasRobots(
      "User-agent: *\nAllow: /private/\nDisallow: /private//\n",
    );
    expect(robotsAllows("/private//secret", policy)).toBe(false);
    expect(robotsAllows("/private/secret", policy)).toBe(true);
  });

  it("preserves encoded reserved octets and malformed escapes", () => {
    const policy = parseAtlasRobots(
      "User-agent: *\nDisallow: /private\nAllow: /private/%2A/public\n",
    );
    expect(robotsAllows("/private/secret/public", policy)).toBe(false);
    expect(robotsAllows("/private/*/public", policy)).toBe(false);
    expect(robotsAllows("/priv%61te/%ZZ", policy)).toBe(false);
  });

  it("normalizes Unicode literals and UTF-8 escapes equivalently", () => {
    const policy = parseAtlasRobots("User-agent: *\nDisallow: /café\n");
    expect(robotsAllows("/caf%C3%A9", policy)).toBe(false);
    expect(robotsAllows("/café/page", policy)).toBe(false);
  });

  it("normalizes UTF-8 replacement characters and preserves malformed leads", () => {
    const policy = parseAtlasRobots("User-agent: *\nDisallow: /�\nDisallow: /bad\n");
    expect(robotsAllows("/%EF%BF%BD", policy)).toBe(false);
    expect(robotsAllows("/bad/%E2%2F", policy)).toBe(false);
  });

  it("uses only the most specific matching user-agent group", () => {
    const policy = parseAtlasRobots(
      "User-agent: Awwwards\nAllow: /private/secret\n\nUser-agent: AwwwardsAtlas\nDisallow: /private\n",
      "AwwwardsAtlas",
    );
    expect(robotsAllows("/private/secret", policy)).toBe(false);
  });

  it("uses the most specific robots group and longest matching rule", () => {
    const policy = parseAtlasRobots(
      [
        "User-agent: *",
        "Disallow: /",
        "",
        "User-agent: AwwwardsAtlas",
        "Disallow: /private",
        "Allow: /private/public",
      ].join("\n"),
    );
    expect(robotsAllows("/work", policy)).toBe(true);
    expect(robotsAllows("/private/secret", policy)).toBe(false);
    expect(robotsAllows("/private/public/page", policy)).toBe(true);
  });

  it("allows a missing robots file and blocks policy fetch failures", async () => {
    const url = new URL("https://example.com/work");
    expect(
      await checkAtlasRobots(url, async () => ({ status: 404, text: "" })),
    ).toEqual({ allowed: true });
    expect(
      await checkAtlasRobots(url, async () => ({ error: "network down" })),
    ).toMatchObject({ allowed: false, limitation: "ROBOTS_UNAVAILABLE" });
    expect(
      await checkAtlasRobots(url, async () => ({ status: 500, text: "" })),
    ).toMatchObject({ allowed: false, limitation: "ROBOTS_UNAVAILABLE" });
  });

  it("permits only exact www/non-www and HTTP→HTTPS redirects", () => {
    expect(
      checkAtlasRedirect("http://example.com/work", "https://www.example.com/work"),
    ).toEqual({ ok: true });
    expect(
      checkAtlasRedirect("https://example.com/work", "https://evil.example/work"),
    ).toMatchObject({ ok: false, code: "DESTINATION_CHANGED" });
    expect(
      checkAtlasRedirect("https://example.com/work", "https://example.com/other"),
    ).toMatchObject({ ok: false, code: "DESTINATION_CHANGED" });
    expect(
      checkAtlasRedirect("https://example.com/work", "https://example.com/work?x=1"),
    ).toMatchObject({ ok: false, code: "DESTINATION_CHANGED" });
  });

  it("blocks mutating methods", () => {
    expect(isMutatingMethod("GET")).toBe(false);
    expect(isMutatingMethod("HEAD")).toBe(false);
    expect(isMutatingMethod("POST")).toBe(true);
    expect(isMutatingMethod("DELETE")).toBe(true);
  });

  it("allows only explicitly listed private fixture origins", async () => {
    const origin = "http://127.0.0.1:43123";
    const denied = createSceneUrlGate(async () => ["127.0.0.1"], []);
    const allowed = createSceneUrlGate(async () => ["127.0.0.1"], [origin]);
    expect(await denied.allows(`${origin}/fixture`)).toBe(false);
    expect(await allowed.allows(`${origin}/fixture`)).toBe(true);
    expect(await allowed.allows("http://127.0.0.1:43124/fixture")).toBe(false);
  });
});
