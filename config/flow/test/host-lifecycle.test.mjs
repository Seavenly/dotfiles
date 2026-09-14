import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const flowRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = dirname(dirname(flowRoot));

test("host lifecycle sources are explicit opt-in and supervise one owner", async () => {
  const [wrapper, macos, ubuntu, docs, miseMacos, miseLinux] = await Promise.all([
    readFile(join(flowRoot, "host", "flow-owner"), "utf8"),
    readFile(join(flowRoot, "host", "macos", "com.seavenly.flow-owner.plist"), "utf8"),
    readFile(join(flowRoot, "host", "ubuntu", "flow-owner.service"), "utf8"),
    readFile(join(flowRoot, "host", "README.md"), "utf8"),
    readFile(join(repositoryRoot, "mise.macos.toml"), "utf8"),
    readFile(join(repositoryRoot, "mise.linux.toml"), "utf8"),
  ]);

  assert.match(wrapper, /^#!\/usr\/bin\/env bash/mu);
  assert.match(wrapper, /FLOW_OWNER_PROCESS=1/u);
  assert.match(wrapper, /exec node .*owner-process\.mjs/u);
  assert.match(macos, /com\.seavenly\.flow-owner/u);
  assert.match(macos, /RunAtLoad/u);
  assert.match(macos, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/u);
  assert.match(macos, /\.config\/flow\/host\/flow-owner/u);
  assert.match(ubuntu, /ExecStart=%h\/\.config\/flow\/host\/flow-owner/u);
  assert.match(ubuntu, /Restart=on-failure/u);
  assert.match(docs, /flow start --json/u);
  assert.match(docs, /systemctl --user enable --now/u);
  assert.match(docs, /launchctl bootstrap/u);
  assert.match(docs, /does not install either host-manager definition/u);

  // The ordinary convergence manifests must not put either definition into a
  // manager-owned directory or silently enable the replacement selector.
  assert.doesNotMatch(miseMacos, /LaunchAgents|flow-owner\.plist/u);
  assert.doesNotMatch(miseLinux, /systemd\/user|flow-owner\.service/u);
});
