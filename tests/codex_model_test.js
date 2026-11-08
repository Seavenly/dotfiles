// Tests for config/claude/scripts/codex-model.js against a fake `codex`
// binary that serves a fixture catalog.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const modulePath = path.resolve(__dirname, "../config/claude/scripts/codex-model.js");

const levels = (...e) => e.map((effort) => ({ effort }));
const CATALOG = {
  models: [
    { slug: "gpt-6-sol", visibility: "list", priority: 3, supported_reasoning_levels: levels("low", "medium"), default_reasoning_level: "medium" },
    { slug: "gpt-6.10-sol", visibility: "list", priority: 1, supported_reasoning_levels: levels("medium", "high"), default_reasoning_level: "medium" },
    { slug: "gpt-6.9-sol", visibility: "list", priority: 0, supported_reasoning_levels: levels("medium"), default_reasoning_level: "medium" },
    { slug: "gpt-7-sol", visibility: "hide", priority: 0 },
    { slug: "gpt-6.1-luna", visibility: "list", priority: 2 },
    { slug: "gpt-6-sol-mini", visibility: "list", priority: 0 },
  ],
};

// mode: "live" serves the catalog, "bundled" serves it only with --bundled,
// "down" fails every call.
function resolve(t, spec, effort, mode, cacheFile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-model-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const catalogFile = path.join(dir, "catalog.json");
  fs.writeFileSync(catalogFile, JSON.stringify(CATALOG));
  const bin = path.join(dir, "codex");
  fs.writeFileSync(bin, `#!/bin/sh
echo "warning: noise" >&2
case "${mode}" in
  live) cat '${catalogFile}' ;;
  bundled) [ "$3" = "--bundled" ] && cat '${catalogFile}' || exit 1 ;;
  *) exit 1 ;;
esac
`);
  fs.chmodSync(bin, 0o755);
  const cache = cacheFile || path.join(dir, "cache.json");
  const r = spawnSync(process.execPath, ["-e", `process.stdout.write(JSON.stringify(require(${JSON.stringify(modulePath)}).resolveCodexModel(${JSON.stringify(spec)}, ${JSON.stringify(effort)})))`], {
    encoding: "utf8", env: { ...process.env, CODEX_BIN: bin, CODEX_MODEL_CACHE: cache },
  });
  assert.equal(r.status, 0, r.stderr);
  return { result: JSON.parse(r.stdout), cache };
}

test("latest-sol picks the highest listed version, comparing segments as integers", (t) => {
  const { result } = resolve(t, "latest-sol", "medium", "live");
  assert.deepEqual(result, { requested: "latest-sol", model: "gpt-6.10-sol", effort: "medium", source: "catalog" });
});

test("an explicit slug is a pin and skips the catalog", (t) => {
  const { result } = resolve(t, "gpt-6-sol", "medium", "down");
  assert.equal(result.model, "gpt-6-sol");
  assert.equal(result.source, "pinned");
});

test("the bundled catalog is used when the live one is unavailable", (t) => {
  const { result } = resolve(t, "latest-sol", "medium", "bundled");
  assert.equal(result.model, "gpt-6.10-sol");
  assert.equal(result.source, "bundled-catalog");
});

test("the last resolved slug is used offline, and nothing at all yields no model", (t) => {
  const first = resolve(t, "latest-sol", "medium", "live");
  const offline = resolve(t, "latest-sol", "medium", "down", first.cache);
  assert.equal(offline.result.model, "gpt-6.10-sol");
  assert.equal(offline.result.source, "cache");
  const none = resolve(t, "latest-sol", "medium", "down");
  assert.equal(none.result.model, null);
});

test("an unsupported effort falls back to the model default and says so", (t) => {
  const { result } = resolve(t, "latest-sol", "xhigh", "live");
  assert.equal(result.effort, "medium");
  assert.match(result.note, /does not list effort xhigh/);
});

test("malformed or unknown families resolve to no model rather than a guess", (t) => {
  assert.equal(resolve(t, "latest-so.l", "medium", "live").result.model, null);
  assert.equal(resolve(t, "latest-terra", "medium", "live").result.model, null);
});
