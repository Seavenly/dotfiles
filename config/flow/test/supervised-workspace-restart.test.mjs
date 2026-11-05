import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const load = path => JSON.parse(readFileSync(path, "utf8"));
function run(executable, args) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(executable, args, { env, encoding: "utf8", timeout: 30000 });
}
function success(executable, args) {
  const result = run(executable, args);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}

for (const mode of ["test", "verify"]) {
  test(`public supervised ${mode} launch survives owner restart after exact preparation`, async (t) => {
    const parent = mkdtempSync(join(tmpdir(), "flow-prelaunch-restart-"));
    const executable = join(parent, "codex-fixture");
    writeFileSync(executable, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.166.0"; exit 0; fi\nexit 99\n', { mode: 0o700 });
    let client;
    t.after(() => {
      if (client) success(client, ["stop", "--json"]);
      rmSync(parent, { recursive: true, force: true });
    });
    const pilot = success(process.execPath, [cli, "pilot", "setup", "--mode", mode,
      "--parent", parent, "--execution-trust", "supervised-native-cli", "--codex-executable", executable]);
    client = join(pilot.directory, "flow");
    success(client, ["start", "--json"]);
    const request = load(join(pilot.directory, "prepare-request.json"));
    const rejected = run(client, ["prepare", "--input", JSON.stringify({ ...request, limits: { ...request.limits, max_cards: 5 } }), "--json"]);
    assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
    const rejectedDatabase = new DatabaseSync(join(pilot.environment.FLOW_AUTHORITY_DIRECTORY, "authority.sqlite"), { readOnly: true });
    try {
      const registrations = rejectedDatabase.prepare("SELECT payload_json FROM authority_events").all()
        .map(row => JSON.parse(row.payload_json)).filter(event => event.type === "workspace_registered");
      assert.equal(registrations.length, 0, "a rejected compile cannot register workspace identity");
    } finally { rejectedDatabase.close(); }
    const prepared = success(client, ["prepare", "--input", JSON.stringify(request), "--json"]);
    success(client, ["prepare", "--input", JSON.stringify(request), "--json"]);
    const preparedPath = join(pilot.directory, "prepared.json");
    writeFileSync(preparedPath, JSON.stringify(prepared));
    const accepted = success(client, ["pilot", "accept-prepared", pilot.directory, preparedPath]);
    success(client, ["stop", "--json"]);
    success(client, ["start", "--json"]);
    const launched = success(client, ["launch", "--input", JSON.stringify(load(accepted.request)), "--json"]);
    assert.equal(launched.schema, "flow.launch-receipt/v1", JSON.stringify(launched));
    // Admission is the regression boundary. Cancel through the returned public
    // action, then require settlement before removing the fixture. No real
    // provider executable or credential is available in this test.
    let cancellationAccepted = false;
    for (let index = 0; index < 10 && !cancellationAccepted; index += 1) {
      const active = success(client, ["query", "--input", JSON.stringify({ run_id: launched.run_id }), "--json"]);
      const cancel = active.views.operator.legal_actions.find(action => action.type === "cancel");
      assert.ok(cancel, "the admitted run must expose its exact cancellation action");
      const result = run(client, ["command", "--input", JSON.stringify(cancel), "--json"]);
      cancellationAccepted = result.status === 0;
      if (!cancellationAccepted) {
        assert.equal(JSON.parse(result.stderr).code, "stale_authority_watermark", result.stderr);
      }
    }
    assert.equal(cancellationAccepted, true);
    const deadline = Date.now() + 15000;
    let projection;
    do {
      projection = success(client, ["query", "--input", JSON.stringify({ run_id: launched.run_id }), "--json"]);
      if (projection.phase === "cancelled") break;
      await delay(50);
    } while (Date.now() < deadline);
    assert.equal(projection.phase, "cancelled", JSON.stringify({ phase: projection.phase, cards: projection.cards }));
    const database = new DatabaseSync(join(pilot.environment.FLOW_AUTHORITY_DIRECTORY, "authority.sqlite"), { readOnly: true });
    try {
      const registrations = database.prepare("SELECT payload_json FROM authority_events").all()
        .map(row => JSON.parse(row.payload_json)).filter(event => event.type === "workspace_registered");
      assert.equal(registrations.length, 1, JSON.stringify(registrations));
      assert.equal(registrations[0].registration.workspace.canonical_path, pilot.environment.FLOW_REPOSITORY_ROOT);
      assert.equal(registrations[0].registration.workspace.canonical_id, prepared.selection.inputs.workspace.subject_id);
    } finally { database.close(); }
  });
}
