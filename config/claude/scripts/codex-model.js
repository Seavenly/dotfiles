// codex-model.js - resolves the Codex model a review runs on.
//
// A spec of `latest-<family>` (for example `latest-sol`) means the newest
// listed `gpt-<version>-<family>` model in Codex's own catalog, so reviews
// follow new releases without editing config. Any other spec is an explicit
// pin and passes through unchanged.
//
// Resolution never falls back to ~/.codex/config.toml's default, which is
// whatever the owner last used interactively. It tries, in order: the live
// catalog (`codex debug models`), the catalog bundled with the binary
// (`--bundled`, no network), then the last slug this resolver chose for the
// family. When all fail it returns model: null and the caller skips Codex.
// Callers record { requested, model, source } so every run shows what ran.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const CACHE = process.env.CODEX_MODEL_CACHE || path.join(os.homedir(), ".agent-teams", "codex-model.json");
const CODEX = process.env.CODEX_BIN || "codex";

function catalog(bundled) {
  const args = ["debug", "models", ...(bundled ? ["--bundled"] : [])];
  // The catalog is about half a megabyte; parse stdout alone, since warnings
  // go to stderr.
  const r = spawnSync(CODEX, args, { encoding: "utf8", timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout);
    return Array.isArray(parsed.models) ? parsed.models : null;
  } catch {
    return null;
  }
}

function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

function newest(models, family) {
  const pattern = new RegExp(`^gpt-(\\d+(?:\\.\\d+)*)-${family}$`);
  const matches = models
    .filter((m) => m && m.visibility === "list" && typeof m.slug === "string" && pattern.test(m.slug))
    .map((m) => ({ m, version: m.slug.match(pattern)[1].split(".").map(Number) }));
  matches.sort((x, y) => compareVersions(y.version, x.version) || (x.m.priority ?? 99) - (y.m.priority ?? 99));
  return matches.length ? matches[0].m : null;
}

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch { return {}; }
}

function writeCache(family, entry) {
  try {
    const all = readCache();
    all[family] = { slug: entry.slug, efforts: entry.efforts, defaultEffort: entry.defaultEffort, at: new Date().toISOString() };
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(`${CACHE}.tmp`, JSON.stringify(all, null, 2));
    fs.renameSync(`${CACHE}.tmp`, CACHE);
  } catch {
    // The cache only helps a later offline run; failing to write it is fine.
  }
}

function describe(m) {
  return {
    slug: m.slug,
    efforts: (m.supported_reasoning_levels || []).map((l) => l && l.effort).filter(Boolean),
    defaultEffort: m.default_reasoning_level || null,
  };
}

// Returns { requested, model, effort, source, note? } or { requested,
// model: null, reason }. The effort falls back to the model's default when
// the model does not advertise the requested level.
function resolveCodexModel(spec, effort) {
  const requested = String(spec || "latest-sol");
  if (!requested.startsWith("latest-")) return { requested, model: requested, effort, source: "pinned" };
  const family = requested.slice("latest-".length);
  if (!/^[a-z]+$/.test(family)) return { requested, model: null, reason: `unsupported model spec ${requested}; use latest-<family> or a model slug` };
  let entry = null;
  let source = null;
  for (const [bundled, name] of [[false, "catalog"], [true, "bundled-catalog"]]) {
    const models = catalog(bundled);
    const m = models && newest(models, family);
    if (m) { entry = describe(m); source = name; break; }
  }
  if (entry) writeCache(family, entry);
  else {
    const cached = readCache()[family];
    if (cached && cached.slug) { entry = cached; source = "cache"; }
  }
  if (!entry) return { requested, model: null, reason: `no listed gpt-<version>-${family} model in the Codex catalog` };
  const result = { requested, model: entry.slug, effort, source };
  if (effort && entry.efforts && entry.efforts.length && !entry.efforts.includes(effort)) {
    result.effort = entry.defaultEffort || undefined;
    result.note = `${entry.slug} does not list effort ${effort}; used ${result.effort || "its default"}`;
  }
  return result;
}

module.exports = { resolveCodexModel, newest, compareVersions };
