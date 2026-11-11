import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { digest } from "../../../tools/flow/src/canonical.mjs";
import { writeFeatureClient } from "../scripts/feature-client-files.mjs";
import { assertLocalCheckChangeQuiescent } from "./local-client-state.mjs";
import { statusFlowOwner } from "./owner-process.mjs";
import { SUPERVISED_NATIVE_ACKNOWLEDGMENT } from "./supervised-native-trust.mjs";
const load = path => JSON.parse(readFileSync(path, "utf8"));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });

/** Refuse redirected existing ancestors before any profile/client write. */
export function assertCanonicalLocalDirectories(...paths) {
  for (const path of paths) for (let current = resolve(path); ; current = dirname(current)) {
    let stat;
    try { stat = lstatSync(current); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(current) !== current)) {
      throw new Error("Local state must retain canonical directory ancestry; aliases and broken paths are unsupported");
    }
    if (dirname(current) === current) break;
  }
}

/** Shared immutable client provisioning. No owner, request or provider is started. */
export async function provisionLocalClient({ repository, executable, gitIdentity, check, runtimeRoot, node, env = process.env, upgradeRuntime, reconfigureCheck, preserveSelectedCheck = false }) {
 const options = { "--upgrade-runtime": upgradeRuntime, "--reconfigure-check": reconfigureCheck };
  const stateHome = env.FLOW_LOCAL_CLIENT_STATE_HOME ?? env.XDG_STATE_HOME ?? join(env.HOME ?? homedir(), ".local/state");
  const parent = join(stateHome, "flow-local");
  const profileRoot = join(parent, digest(repository).slice(7, 31));
  const identity = { schema: "flow.local-client/v1", repository, runtime_root: runtimeRoot,
    node, executable, execution_trust: SUPERVISED_NATIVE_ACKNOWLEDGMENT, git_identity: gitIdentity };
  const checkDigest = check ? digest(check) : null;
  const checkKey = checkDigest?.slice(7) ?? "verify";
  let directory = join(profileRoot, "clients", checkKey);
  const authorityDirectory = join(profileRoot, "authority");
  assertCanonicalLocalDirectories(parent, profileRoot, join(profileRoot, "clients"), authorityDirectory, directory);
  let profile;
  let runtimeChanged = false;
  if (existsSync(profileRoot)) {
    if (!lstatSync(profileRoot).isDirectory() || lstatSync(profileRoot).isSymbolicLink()) throw new Error("Local client path is not an owned profile directory");
    const pinned = load(join(profileRoot, "profile.json"));
    const { runtime_root: originalRuntime, ...originalPins } = pinned.identity;
    const { runtime_root: _selectedRuntime, ...selectedPins } = identity;
    if (digest(originalPins) !== digest(selectedPins)) throw new Error("This repository already has different Node, executable, trust or Git identity pins; retain its authority and existing clients");
    runtimeChanged = originalRuntime !== runtimeRoot;
    if (runtimeChanged) {
      directory = join(profileRoot, "clients", `${checkKey}.runtime-${digest(runtimeRoot).slice(7)}`);
      if (!existsSync(directory) && options["--upgrade-runtime"] !== "yes") throw new Error("Use --upgrade-runtime yes to select a different runtime while retaining the same authority");
    }
    assertCanonicalLocalDirectories(directory);
    const checkKeys = new Set(readdirSync(join(profileRoot, "clients")).map(name => {
      const match = /^(verify|[a-f0-9]{64})(?:\.runtime-[a-f0-9]{64})?$/u.exec(name);
      if (!match) throw new Error("Local client directory has an unknown identity");
      return match[1];
    }));
    const checkChanged = preserveSelectedCheck ? !checkKeys.has(checkKey) : pinned.initial_check_digest !== checkDigest || checkKeys.size > 1;
    if (checkChanged) {
      if (options["--reconfigure-check"] !== "yes") throw new Error("Use --reconfigure-check yes to select a different check while retaining the same authority");
    }
    if (checkChanged || runtimeChanged && options["--upgrade-runtime"] === "yes") {
      const owner = await statusFlowOwner({ authorityDirectory });
      if (owner.state !== "stopped") throw new Error("Stop the existing local owner before selecting a different check or runtime");
      assertLocalCheckChangeQuiescent({ authorityDirectory, repository });
    }
  } else {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    mkdirSync(profileRoot, { mode: 0o700 });
    mkdirSync(join(profileRoot, "clients"), { mode: 0o700 });
    mkdirSync(authorityDirectory, { mode: 0o700 });
    save(join(profileRoot, "profile.json"), { identity, initial_check_digest: checkDigest });
  }
  const reused = existsSync(directory);
  if (reused) {
    profile = load(join(directory, "pilot.json"));
    if (digest(profile.local_client) !== digest(identity)) throw new Error("Local client identity changed");
  } else {
    mkdirSync(directory, { mode: 0o700 });
    for (const name of ["state", "receipts", "requests"]) mkdirSync(join(directory, name), { mode: 0o700 });
    const clientFiles = writeFeatureClient({ directory, runtimeRoot, workspace: repository,
      featureTestCheck: check, executionTrust: "supervised-native-cli", codexExecutable: executable.path, localStateHome: stateHome, authorityDirectory, gitIdentity });
    profile = { directory, runtime_root: runtimeRoot, ...clientFiles, local_client: identity,
      execution_trust: SUPERVISED_NATIVE_ACKNOWLEDGMENT };
    save(join(directory, "pilot.json"), profile);
  }
  return { stateHome, profileRoot, authorityDirectory, directory, profile, reused, runtimeChanged };
}
