import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const descriptor = readJson("../server.json");
const pkg = readJson("../package.json");
const remote = descriptor.remotes[0];
const metadata = descriptor._meta["io.modelcontextprotocol.registry/publisher-provided"];

test("registry identity and version match this repository", () => {
  assert.equal(descriptor.name, `io.github.OlegNickeshin/${pkg.name}`);
  assert.equal(descriptor.version, pkg.version);
  assert.equal(`${descriptor.repository.url}.git`, pkg.repository.url.replace(/^git\+/, ""));
  assert.equal(descriptor.repository.source, "github");
  assert.ok(descriptor.description.length > 0 && descriptor.description.length <= 100);
});

test("remote requires the user's host and a secret, never a bundled credential", () => {
  assert.equal(descriptor.remotes.length, 1);
  assert.equal(remote.type, "streamable-http");
  assert.equal(remote.url, "https://{host}/tg-mcp/{secret}");
  const placeholders = [...remote.url.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
  assert.deepEqual(placeholders.sort(), Object.keys(remote.variables).sort());
  for (const variable of Object.values(remote.variables)) {
    assert.equal(variable.isRequired, true);
    assert.equal("default" in variable, false);
    assert.equal("value" in variable, false);
    assert.equal("choices" in variable, false);
  }
  assert.equal(remote.variables.secret.isSecret, true);
  assert.equal(descriptor.packages, undefined); // This is not an npm/stdio installation.
});

test("template resolves to the documented reverse proxy path", () => {
  // Synthetic test values, never a live endpoint or Telegram credential.
  const values = { host: "telegram.example.org:8443", secret: "a".repeat(64) };
  const resolved = new URL(remote.url.replace(/\{([^}]+)\}/g, (_, key) => values[key]));
  assert.equal(resolved.protocol, "https:");
  assert.equal(resolved.host, values.host);
  assert.equal(resolved.pathname, `/tg-mcp/${values.secret}`);
  assert.equal(resolved.search, "");
});

test("discovery metadata explains opt-in writes and archive limitations", () => {
  assert.ok(metadata.tags.includes("self-hosted"));
  assert.ok(metadata.tags.includes("conversation-search"));
  assert.match(metadata.usage, /not a shared public Telegram service/);
  assert.match(metadata.limitations, /full-text, not semantic/);
  assert.match(metadata.limitations, /ALLOW_SEND=1/);
  assert.match(metadata.limitations, /ALLOW_MEDIA=1/);
  assert.match(metadata.limitations, /local transcription/);
  assert.match(metadata.safety, /untrusted data, not instructions/);
  assert.match(metadata.safety, /Confirm recipient and wording/);
  assert.ok(Buffer.byteLength(JSON.stringify(descriptor._meta)) < 4096);
});
