import assert from "node:assert/strict";
import test from "node:test";

import { digestCanonical } from "../src/canonical-json.mjs";
import {
  publicCompatibility,
  publicErrorDetails,
} from "../src/public-output.mjs";

test("public compatibility details redact exact managed identity mismatch values", () => {
  const expected = {
    schema: "drovr.managed-pane-runtime-identity/v1",
    pane_id: "pane-private",
    native_session: "native-private",
    process: { pid: 42, cwd: "/private/worktree" },
  };
  const observed = {
    ...expected,
    native_session: "native-replaced",
    process: { pid: 43, cwd: "/private/other-worktree" },
  };
  const details = publicErrorDetails({
    expected,
    observed,
    mismatches: [
      {
        field: "managed_pane_identity.native_session",
        expected: expected.native_session,
        observed: observed.native_session,
        reason: "changed",
      },
      {
        field: "managed_pane_identity.process",
        expected: expected.process,
        observed: observed.process,
        reason: "changed",
      },
    ],
  });

  assert.deepEqual(details.expected, {
    managed_runtime_evidence_digest: digestCanonical(expected),
  });
  assert.deepEqual(details.observed, {
    managed_runtime_evidence_digest: digestCanonical(observed),
  });
  assert.deepEqual(details.mismatches, [
    {
      field: "managed_pane_identity.native_session",
      expected_digest: digestCanonical(expected.native_session),
      observed_digest: digestCanonical(observed.native_session),
      reason: "changed",
    },
    {
      field: "managed_pane_identity.process",
      expected_digest: digestCanonical(expected.process),
      observed_digest: digestCanonical(observed.process),
      reason: "changed",
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(details),
    /pane-private|native-private|native-replaced|private-worktree/u,
  );
});

test("public compatibility recursively redacts nested managed identity evidence", () => {
  const expected = {
    schema: "drovr.managed-pane-runtime-identity/v1",
    pane_id: "pane-private",
    process: { pid: 42, cwd: "/private/worktree" },
  };
  const observed = {
    ...expected,
    process: { pid: 43, cwd: "/private/other-worktree" },
  };
  const projected = publicCompatibility({
    facts: { harness: "codex" },
    nested: {
      managed_pane_identity: expected,
      mismatch: {
        field: "managed_pane_identity.process",
        expected,
        observed,
        reason: "changed",
      },
    },
  });

  assert.equal(projected.nested.managed_pane_identity, undefined);
  assert.deepEqual(projected.nested.mismatch, {
    field: "managed_pane_identity.process",
    expected_digest: digestCanonical(expected),
    observed_digest: digestCanonical(observed),
    reason: "changed",
  });
  assert.doesNotMatch(
    JSON.stringify(projected),
    /pane-private|private-worktree|other-worktree/u,
  );
});
