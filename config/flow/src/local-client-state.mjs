import { digest } from "../../../tools/flow/src/canonical.mjs";
import { createDurableRunAuthority } from "../../../tools/flow/src/run-authority.mjs";
import { getWorkspaceAuthority } from "../../../tools/flow/src/work-authority.mjs";
import { resolveProductionFeatureTestSelection } from "./production-feature-test-check.mjs";

const terminal = run => ["succeeded", "failed", "cancelled", "declined"].includes(run.phase);
const settled = run => run.effects.every(effect => ["succeeded", "not_created", "quarantined", "abandoned", "late_succeeded", "late_quarantined"].includes(effect.status));

function retainedRuns(authority) {
  const host = authority.query();
  if (host.schema !== "flow.run-index-projection/v1" || !Array.isArray(host.runs) ||
      !["compatible", "uninitialized"].includes(host.authority_schema?.status)) throw new Error("Local authority cannot be inspected safely");
  return host.runs.map(id => {
    const run = authority.query(id);
    if (run.schema !== "flow.run-projection/v1" || !Array.isArray(run.effects)) throw new Error("Retained run cannot be inspected safely");
    return run;
  });
}

/** Check changes never acquire mutation authority or alter retained history. */
export function assertLocalCheckChangeQuiescent({ authorityDirectory, repository }) {
  const authority = createDurableRunAuthority({ authorityDirectory, access: "inspect" });
  try {
    if (retainedRuns(authority).some(run => !terminal(run) || !settled(run))) throw new Error("Settle every retained run and uncertain effect before selecting a different check");
    const repositoryId = `repository:${digest(repository).slice(7)}`;
    const subject = `workspace:${digest({ repository_id: repositoryId, canonical_path: repository }).slice(7)}`;
    const workspace = getWorkspaceAuthority({ runAuthority: authority }).query({ contract: "work.workspace/v1", subject_id: subject });
    if (workspace.schema === "work.workspace-projection/v1") {
      if (workspace.claims.length !== 0 || workspace.taint !== null) throw new Error("Settle retained workspace claims and taint before selecting a different check");
    } else if (workspace.code !== "unknown_subject") throw new Error("Workspace authority cannot be inspected safely");
  } finally { authority.close(); }
}

/** Runs under the existing authority lease, before recovery can dispatch work. */
export function assertCompatibleLocalCheck(authority, { repository, featureTestCheck }) {
  let expected;
  for (const run of retainedRuns(authority)) {
    if (terminal(run) && settled(run)) continue;
    const fingerprints = collectFingerprints(run.active_plan);
    if (fingerprints.length === 0) continue;
    if (expected === undefined) {
      if (!featureTestCheck) throw new Error("Retained checked work requires its original local client");
      expected = resolveProductionFeatureTestSelection({ checkId: featureTestCheck.check_id,
        brief: { acceptance: featureTestCheck.criteria }, workspace: { path: repository }, featureTestCheck }).checkBinding.fingerprint;
    }
    if (fingerprints.some(value => value !== expected)) throw new Error("Retained checked work requires its original local client");
  }
}

function collectFingerprints(value) {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, entry]) => key === "environment_fingerprint" ? [entry] : collectFingerprints(entry));
}
