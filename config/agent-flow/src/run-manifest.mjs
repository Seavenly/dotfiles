import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { validateContract } from "./schema-validator.mjs";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export async function loadRunManifest({ runId, env = process.env }) {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error("invalid run ID");
  const stateHome = env.XDG_STATE_HOME?.trim() ||
    (env.HOME ? join(env.HOME, ".local", "state") : null);
  if (!stateHome) throw new Error("HOME or XDG_STATE_HOME is required");
  const runDirectory = join(stateHome, "agent-flow", "runs", runId);
  const manifestPath = join(runDirectory, "run.json");
  let manifest;
  let manifestBytes;
  try {
    manifestBytes = await readFile(manifestPath);
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`unknown run: ${runId}`);
    throw new Error(`cannot read run manifest for ${runId}`, { cause: error });
  }
  if (!(await validateContract(manifest)).valid) {
    throw new Error(`run ${runId} has an invalid manifest`);
  }
  if (
    manifest.identity.run_id !== runId ||
    manifest.identity.run_directory !== runDirectory
  ) {
    throw new Error(`run ${runId} manifest does not match its state directory`);
  }
  return { manifest, manifestBytes, manifestPath, runDirectory };
}
