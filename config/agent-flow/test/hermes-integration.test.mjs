import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

import { doctorProfiles } from "../src/doctor.mjs";
import {
  PROFILE_CATALOG,
  PROFILE_NAMES,
  SUPPORTED_HERMES_VERSIONS,
} from "../src/profile-catalog.mjs";
import { renderProfiles } from "../src/profiles.mjs";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../../..", import.meta.url));

test("real Hermes accepts every managed profile and exposes its exact worker tools", async (t) => {
  let installedVersion;
  try {
    const { stdout } = await execFileAsync("hermes", ["--version"], {
      encoding: "utf8",
    });
    installedVersion = stdout.match(/Hermes Agent v(\d+\.\d+\.\d+)/)?.[1];
  } catch {
    t.skip("Hermes is not installed");
    return;
  }
  if (!SUPPORTED_HERMES_VERSIONS.includes(installedVersion)) {
    t.skip(`Hermes ${installedVersion ?? "unknown"} is not validated`);
    return;
  }

  const base = await mkdtemp(join(tmpdir(), "agent-flow-real-hermes-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, "home");
  const configHome = join(home, ".config");
  const routingFile = join(configHome, "dotfiles", "hermes-routing.yaml");
  await mkdir(join(configHome, "dotfiles"), { recursive: true });
  await writeFile(
    routingFile,
    "schema: dotfiles.hermes-routing/v1\nprofiles: {}\n",
  );
  await renderProfiles({ root, home, configHome, routingFile });

  const runHermes = async (args, options = {}) => {
    const { stdout } = await execFileAsync("hermes", args, {
      encoding: "utf8",
      env: { ...process.env, HOME: home, ...options.env },
    });
    return stdout;
  };
  const report = await doctorProfiles({ home, runHermes });

  assert.equal(
    report.checks.find(({ id }) => id === "hermes-version").ok,
    true,
  );
  assert.equal(report.checks.find(({ id }) => id === "toolsets").ok, true);
  assert.equal(
    report.checks.find(({ id }) => id === "native-config").ok,
    true,
  );
  assert.equal(
    report.checks.find(({ id }) => id === "trust-posture").ok,
    true,
  );
  assert.match(report.profileSetFingerprint, /^sha256:[a-f0-9]{64}$/);
  for (const name of ["builder", "gate"]) {
    const terminal = report.profiles.find(
      (profile) => profile.name === name,
    ).trust.terminal;
    assert.equal(terminal.inheritsRealUserHome, true);
    assert.equal(terminal.homeReadable, true);
    assert.equal(terminal.ordinaryEnvironmentInherited, true);
    assert.equal(terminal.normalCliCredentialsReachable, true);
    assert.equal(terminal.providerSecretsFilteredByDefault, true);
    assert.equal(terminal.gatewaySecretsFiltered, true);
  }
  assert.deepEqual(
    report.profiles.map(({ name, workerTools, dispatchOwner }) => ({
      name,
      workerTools,
      dispatchOwner,
    })),
    PROFILE_NAMES.map((name) => ({
      name,
      workerTools: PROFILE_CATALOG[name].workerTools,
      dispatchOwner: name === "flow-controller",
    })),
  );
});
