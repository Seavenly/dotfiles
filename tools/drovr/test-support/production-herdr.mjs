import assert from "node:assert/strict";
import { chmod, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { digestCanonical } from "../src/canonical-json.mjs";
import {
  COMPATIBILITY_FEATURES,
  PRODUCTION_ADAPTER_ID,
} from "../src/compatibility.mjs";

// These values describe the production-shaped Herdr 0.8 runtime used by the
// public CLI fixtures. The managed executable and process facts are emitted
// by the fake Herdr pane and then qualified by Drovr's real production
// adapter, so a compatibility contract change fails at this boundary.
export const PRODUCTION_HERDR_RUNTIME = Object.freeze({
  herdrVersion: "herdr 0.8.0",
  harnessVersion: "codex-cli 0.146.1",
  integrationLine: "codex: current (v7)",
  integration: "herdr-codex/v7",
  nativeSession: "native-codex-1",
  model: "gpt-5.6-luna",
  effort: "low",
});

export function assertResultStatus(report, command, status) {
  const serialized = JSON.stringify(report);
  assert.equal(report.schema, "drovr.command/v1", serialized);
  assert.equal(report.command, command, serialized);
  assert.equal(report.ok, true, serialized);
  assert.equal(report.result?.status, status, serialized);
}

export function productionCompatibilityFacts() {
  return {
    drovr: "drovr.semantic-harness/v1",
    herdr: PRODUCTION_HERDR_RUNTIME.herdrVersion,
    harness: PRODUCTION_HERDR_RUNTIME.harnessVersion,
    integration: PRODUCTION_HERDR_RUNTIME.integration,
    adapters: [PRODUCTION_ADAPTER_ID, "codex-jsonl/v1"],
    features: [...COMPATIBILITY_FEATURES],
  };
}

export function productionCompatibilityEvidenceDigest() {
  return digestCanonical(productionCompatibilityFacts());
}

export async function productionManagedRuntimeIdentity({
  codexPath,
  cwd,
  path,
  managedAgent = "managed-agent",
  paneId = "pane-agent-1",
}) {
  const metadata = await stat(codexPath);
  const fileIdentity = {
    device: Number(metadata.dev),
    inode: Number(metadata.ino),
    size: Number(metadata.size),
    mtime_ms: metadata.mtimeMs,
  };
  return {
    schema: "drovr.managed-pane-runtime-identity/v1",
    harness: "codex",
    managed_agent: managedAgent,
    pane_id: paneId,
    executable: {
      observed_path: codexPath,
      canonical_path: codexPath,
      version: PRODUCTION_HERDR_RUNTIME.harnessVersion,
      file_identity: fileIdentity,
    },
    managed_path_digest: digestCanonical(path),
    caller_path_digest: digestCanonical(path),
    integration: PRODUCTION_HERDR_RUNTIME.integration,
    native_session: PRODUCTION_HERDR_RUNTIME.nativeSession,
    process: {
      pid: 2147483647,
      name: "codex",
      argv0: codexPath,
      argv: [codexPath, "--sandbox", "read-only"],
      cmdline: `${codexPath} --sandbox read-only`,
      cwd,
    },
    model: PRODUCTION_HERDR_RUNTIME.model,
    effort: PRODUCTION_HERDR_RUNTIME.effort,
  };
}

export async function installProductionCliRuntime(fakeBin) {
  const codexPath = join(fakeBin, "codex");
  await writeFile(
    codexPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ \${1:-} == --version ]]; then
  printf '%s\\n' '${PRODUCTION_HERDR_RUNTIME.harnessVersion}'
else
  printf '%s\\n' '--model --sandbox --ask-for-approval --search'
fi
`,
  );
  await chmod(codexPath, 0o755);

  // The managed process in these fixtures uses a synthetic PID. Providing a
  // boundary-local ps command lets the real process identity adapter resolve
  // that PID to the fixture executable without inspecting the host process
  // table or weakening the identity check.
  const psPath = join(fakeBin, "ps");
  await writeFile(
    psPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ \${1:-} == -p && \${2:-} == 2147483647 && \${3:-} == -o ]]; then
  case "\${4:-}" in
    comm=|command=) printf '%s\\n' ${shellString(codexPath)}; exit 0 ;;
  esac
fi
exit 1
`,
  );
  await chmod(psPath, 0o755);

  return { codexPath };
}

export function productionCompatibilityPrelude() {
  return `if [[ \${1:-} == --version ]]; then
  printf '%s\\n' '${PRODUCTION_HERDR_RUNTIME.herdrVersion}'
  exit
fi
if [[ \${1:-} == integration && \${2:-} == status ]]; then
  printf '%s\\n' '${PRODUCTION_HERDR_RUNTIME.integrationLine}'
  printf '%s\\n' 'claude: current (v7)'
  exit
fi
`;
}

export function productionManagedRuntimeVariables({
  herdrState,
  cwd,
  codexPath,
}) {
  return `fixtureState=${shellString(herdrState)}
fixtureCwd=${shellString(cwd)}
fixtureCodex=${shellString(codexPath)}
fixtureStarted='started'
fixtureManagedPath="$PATH"
fixtureNativeSession=${shellString(PRODUCTION_HERDR_RUNTIME.nativeSession)}
`;
}

export function productionManagedRuntimeCases({
  ambiguous = false,
  paneId = "pane-1",
} = {}) {
  const processEntry = `{"pid":2147483647,"name":"codex","argv0":"%s","argv":["%s","--sandbox","read-only"],"cmdline":"%s --sandbox read-only","cwd":"%s","environment":{"PATH":"%s"}}`;
  const processEntries = ambiguous
    ? `${processEntry},${processEntry}`
    : processEntry;
  const runningProcessFormat = shellString(
    `{"result":{"type":"pane_process_info","process_info":{"pane_id":${JSON.stringify(paneId)},"shell_pid":10,"foreground_processes":[${processEntries}]}}}\\n`,
  );
  const shellProcessFormat = shellString(
    `{"result":{"type":"pane_process_info","process_info":{"pane_id":${JSON.stringify(paneId)},"shell_pid":10,"foreground_processes":[{"pid":10,"name":"zsh"}]}}}\\n`,
  );
  const processArguments = ambiguous
    ? `"$fixtureCodex" "$fixtureCodex" "$fixtureCodex" "$fixtureCwd" "$fixtureManagedPath" "$fixtureCodex" "$fixtureCodex" "$fixtureCodex" "$fixtureCwd" "$fixtureManagedPath"`
    : `"$fixtureCodex" "$fixtureCodex" "$fixtureCodex" "$fixtureCwd" "$fixtureManagedPath"`;

  return `  "pane process-info")
    if [[ -f "$fixtureState/$fixtureStarted" ]]; then
      printf ${runningProcessFormat} ${processArguments}
    else
      printf ${shellProcessFormat}
    fi
    ;;
  "pane run")
    marker=$(printf '%s\\n' "\${4:-}" | sed -n 's/.*\\(DROVR_RUNTIME_ID_[0-9a-f]*\\).*/\\1/p')
    printf '%s\\t%s\\t%s\\t%s\\n' "$marker" "$fixtureCodex" '${PRODUCTION_HERDR_RUNTIME.harnessVersion}' "$fixtureManagedPath" > "$fixtureState/probe"
    printf '%s\\n' '{"result":{"status":"accepted"}}'
    ;;
  "pane read")
    cat "$fixtureState/probe"
    ;;
`;
}

function shellString(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
