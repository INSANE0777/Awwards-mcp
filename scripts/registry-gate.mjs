#!/usr/bin/env node
// Keep package.json, server.json and the npm package identity in lockstep.
// This is a release gate, not a schema validator for the upstream registry.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SCHEMA_URL = "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";
const NAME = /^io\.github\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/[a-z0-9._-]+$/;
const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;

export function validateRegistryMetadata(pkg, server) {
  const errors = [];
  const expect = (ok, message) => {
    if (!ok) errors.push(message);
  };

  expect(nonEmpty(pkg.name), "package.json name is required");
  expect(nonEmpty(pkg.version) && (pkg.version ?? "").length <= 255, "package.json version must be 1-255 characters");
  expect(nonEmpty(pkg.description) && pkg.description.length <= 100, "package.json description must be 1-100 characters");
  expect(nonEmpty(pkg.mcpName), "package.json mcpName is required");
  expect((pkg.mcpName ?? "").length <= 200, "package.json mcpName must be at most 200 characters");
  expect(NAME.test(pkg.mcpName ?? ""), `package.json mcpName must match io.github.<owner>/<server>, got ${JSON.stringify(pkg.mcpName)}`);
  expect(nonEmpty(server.name), "server.json name is required");
  expect((server.name ?? "").length <= 200, "server.json name must be at most 200 characters");
  expect(nonEmpty(server.version) && (server.version ?? "").length <= 255, "server.json version must be 1-255 characters");
  expect(server.version !== "latest", "server.json version must be a specific version, not latest");
  expect(nonEmpty(server.description), "server.json description is required");
  expect(server.name === pkg.mcpName, `server.json name ${JSON.stringify(server.name)} must equal mcpName ${JSON.stringify(pkg.mcpName)}`);
  expect(server.version === pkg.version, `server.json version ${JSON.stringify(server.version)} must equal package version ${JSON.stringify(pkg.version)}`);
  expect(
    server.$schema === SCHEMA_URL,
    `server.json $schema must be ${SCHEMA_URL}`,
  );
  expect(
    server.repository?.source === "github" &&
      nonEmpty(server.repository?.url) &&
      server.repository.url.replace(/\.git$/, "") === pkg.repository?.url?.replace(/^git\+/, "").replace(/\.git$/, ""),
    "server.json repository must match package.json repository",
  );

  if (server.websiteUrl !== undefined) {
    let validUrl = typeof server.websiteUrl === "string";
    if (validUrl) {
      try {
        new URL(server.websiteUrl);
      } catch {
        validUrl = false;
      }
    }
    expect(validUrl, "server.json websiteUrl must be a URI string");
  }

  const packages = Array.isArray(server.packages) ? server.packages : [];
  expect(packages.length === 1, `server.json must list exactly one package, got ${packages.length}`);
  const entry = packages[0] ?? {};
  expect(nonEmpty(entry.identifier), "server.json package identifier is required");
  expect(nonEmpty(entry.version), "server.json package version is required");
  expect(entry.version !== "latest", "server.json package version must be a specific version, not latest");
  expect((entry.version ?? "").length <= 255, "server.json package version must be at most 255 characters");
  expect(entry.registryType === "npm", "server.json package registryType must be npm");
  expect(entry.identifier === pkg.name, `server.json identifier ${JSON.stringify(entry.identifier)} must equal npm name ${JSON.stringify(pkg.name)}`);
  expect(entry.version === pkg.version, `server.json package version ${JSON.stringify(entry.version)} must equal package version ${JSON.stringify(pkg.version)}`);
  expect(entry.transport?.type === "stdio", "server.json package transport must be stdio");
  expect(server.description === pkg.description, "server.json description must equal package.json description");

  return errors;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const server = JSON.parse(readFileSync("server.json", "utf8"));
  const errors = validateRegistryMetadata(pkg, server);
  if (errors.length) {
    for (const error of errors) console.error(`registry-gate: ${error}`);
    process.exit(1);
  }
  console.log(`registry-gate: ${server.name} ${server.version} npm:${pkg.name} OK`);
}
