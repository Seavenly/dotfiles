import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const flowRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = dirname(dirname(flowRoot));
const guidePath = join(repositoryRoot, "docs/flow/operator-guide.md");

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function mustContain(text, value, message = value) {
  assert.ok(text.includes(value), `operator guide is missing ${message}`);
}

test("operator guide binds the qualified release and public operator path", async () => {
  const [guide, readme, manifest, policy, ledger, catalog, releaseContent,
    qualificationEvidence, productionEvidence] = await Promise.all([
    readFile(guidePath, "utf8"),
    readFile(join(repositoryRoot, "README.md"), "utf8"),
    readJson(join(flowRoot, "release-manifest.v1.json")),
    readJson(join(flowRoot, "launch-policy.v1.json")),
    readJson(join(flowRoot, "transition-ledger.v1.json")),
    readJson(join(flowRoot, "contracts/catalog.v1.json")),
    readJson(join(flowRoot, "evidence/release-content.v1.json")),
    readJson(join(flowRoot, "evidence/release-qualification.v1.json")),
    readJson(join(flowRoot, "evidence/production-route-conformance.v1.json")),
  ]);

  mustContain(readme, "docs/flow/operator-guide.md", "README discovery link");
  mustContain(guide, manifest.release_id, "release ID");
  mustContain(guide, manifest.implementation, "implementation ID");
  mustContain(guide, `flow.contract-catalog/v1@${catalog.catalog_version}`,
    "catalog identity");
  mustContain(guide, policy.schema, "launch-policy contract");
  mustContain(guide, ledger.schema, "transition-ledger contract");
  mustContain(guide, `sequence ${ledger.sequence}`, "ledger sequence");
  mustContain(guide, ledger.release.source_commit, "historical release source commit");
  mustContain(guide, releaseContent.git_binding.candidate_tree_sha,
    "current governed candidate tree");
  mustContain(guide, releaseContent.content_digest, "current release content digest");
  mustContain(guide, releaseContent.git_binding.qualification_base_commit,
    "current qualification base commit");

  assert.equal(qualificationEvidence.status, "passed",
    "deterministic qualification evidence is passed");
  assert.equal(productionEvidence.status, "passed",
    "production-route evidence is passed");
  const qualificationCommands = new Map(
    qualificationEvidence.recipe.commands.map((command) => [command.id, command]),
  );
  const productionCommands = new Map(
    productionEvidence.recipe.commands.map((command) => [command.id, command]),
  );
  for (const [recipeName, commands, ids] of [
    ["qualification", qualificationCommands, [
      "host_fault_reboot",
      "production_runtime_reboot",
      "feature_review_drovr_conformance",
      "public_host_negative_routes",
      "launch_selector",
      "release_tree_integrity",
      "schema_contracts",
      "contract_catalog",
    ]],
    ["production route", productionCommands, [
      "production_feature_verify",
      "public_local_review_process",
      "public_drovr_finding_schema",
    ]],
  ]) {
    for (const id of ids) {
      const command = commands.get(id);
      assert.ok(command, `${recipeName} recipe is missing ${id}`);
      assert.equal(typeof command.receipt_path, "string",
        `${recipeName} ${id} receipt path`);
      mustContain(guide, id, `${recipeName} recipe ID ${id}`);
      mustContain(guide, command.receipt_path,
        `${recipeName} receipt path ${command.receipt_path}`);
    }
  }
  assert.ok(productionCommands.has("production_feature_verify"),
    "production feature verify recipe ID");
  assert.ok(productionCommands.has("public_local_review_process"),
    "public local review recipe ID");

  for (const [label, path] of [
    ["manifest", "release-manifest.v1.json"],
    ["catalog", "contracts/catalog.v1.json"],
    ["policy", "launch-policy.v1.json"],
    ["ledger", "transition-ledger.v1.json"],
    ["release content", "evidence/release-content.v1.json"],
    ["qualification evidence", "evidence/release-qualification.v1.json"],
    ["production-route evidence", "evidence/production-route-conformance.v1.json"],
  ]) {
    const sha = await sha256(join(flowRoot, path));
    mustContain(guide, `sha256:${sha}`, `${label} SHA-256`);
    mustContain(guide, path, `${label} path`);
  }

  for (const route of manifest.supported_routes) {
    mustContain(guide, `${route.flow}/${route.mode}`, "supported route");
  }
  for (const route of [...manifest.disabled_routes, ...manifest.sacrificial_followups]) {
    const name = "flow" in route
      ? `${route.flow}/${route.mode}`
      : `issue ${route.issue}`;
    mustContain(guide, name, `disabled or deferred ${name}`);
  }

  for (const command of [
    "flow start --json",
    "flow status --json",
    "flow stop --json",
    "flow prepare --input",
    "flow launch --input",
    "flow command --input",
    "flow query --input",
    "flow watch --input",
    "checkpoint_decision",
    "recovery",
    "cancel",
    "reboot_admission",
    "terminal_disposition",
    "backup_create",
    "backup_reconcile",
    "restore",
    "restore_reconcile",
    "restore_admit",
  ]) {
    mustContain(guide, command, `public command or legal action ${command}`);
  }

  for (const contract of [
    "flow.runtime/v1",
    "flow.feature-preparation-request/v1",
    "flow.predefined-flow-confirmation-decision/v1",
    "flow.closed-fact-observation/v1",
    "flow.query/v1",
    "flow.watch/v1",
    "flow.delegate-input-envelope/v1",
    "work.review/v1",
    "flow.review-inbox-projection/v1",
    "work.review-human-command/v1",
    "flow.resource-handoff/v1",
  ]) {
    mustContain(guide, contract, `contract ${contract}`);
  }

  for (const phrase of [
    "harness: codex",
    "harness: claude",
    "FLOW_RUNNER_DELEGATE_CAPACITY",
    "FLOW_RUNNER_OPERATION_CAPACITY",
    "FLOW_AUTHORITY_DIRECTORY",
    "same-boot",
    "explicit reboot admission",
    "workspace retention",
    "artifact retention",
    "backup",
    "restore",
    "rollback",
    "macOS 26+ arm64",
    "Ubuntu Server 24.04",
    "Ubuntu Server 26.04",
    "RunAuthority",
    "ADR-0007",
    "ADR-0008",
    "issue #85",
    "issue 44",
    "issue 46",
    "issue 84",
  ]) {
    mustContain(guide, phrase, phrase);
  }

  assert.doesNotMatch(guide, /node\s+(?:-e|--eval)|node\s+<<|javascript:/iu,
    "bespoke JavaScript");
  assert.doesNotMatch(guide, /(?:sqlite3|authority\.sqlite|registry|transcript\s+surgery)/iu,
    "private authority or transcript surgery");
  assert.doesNotMatch(guide,
    /(?:candidate|result|review|handoff)[_-](?:sha|hash|digest)\s*[:=]\s*[0-9a-f]{40,}/iu,
    "future result or candidate hash");
  assert.doesNotMatch(guide, /git\s+(?:push|merge)|gh\s+(?:pr|issue)\s+(?:create|merge)/iu,
    "remote mutation command");

  assert.doesNotMatch(guide, /gpt-5\.6/iu, "hard-coded future model");
  assert.match(guide, /authority_watermark|launch_watermark/u,
    "launch receipt watermark");
  assert.doesNotMatch(guide, /\.watermark\|type\s*==\s*["']string["']/u,
    "nonexistent launch receipt watermark");
  assert.match(guide, /prepare\.stderr\.json/u,
    "prepare rejection capture");
  assert.match(guide, /launch\.stderr\.json/u,
    "launch rejection capture");
  assert.match(guide, /FLOW_SOCKET_PATH=/u,
    "explicit flow socket selection");
  assert.match(guide, /chmod\s+700/u,
    "private disposable directories");
  assert.match(guide, /separate terminal/u,
    "non-blocking watch instructions");
  assert.match(guide, /Ctrl-?C|close(?: the)? (?:client|terminal)/iu,
    "watch termination instructions");
  assert.match(guide,
    /schema:\s*["']flow\.command\/v1["']\s*,\s*type:\s*["']backup_create["']/u,
    "explicit initial backup request");
  assert.equal(
    (guide.match(/^flow query delegated-agent --harness codex --role reviewer \\/gmu) ?? []).length,
    2,
    "codex apply and critique queries are not duplicated or orphaned",
  );
  const backupStart = guide.indexOf("## Backup, restore, selector, and rollback");
  const explicitBackup = guide.indexOf("BACKUP_REQUEST", backupStart);
  assert.ok(backupStart >= 0 && explicitBackup > backupStart,
    "initial backup request location");
  assert.doesNotMatch(guide.slice(backupStart, explicitBackup),
    /\.legal_actions\[\].*select\(\.type\s*==\s*["']backup_create["']\)/su,
    "unprojected initial backup action");
  assert.match(guide, /no backup writer.*restore adapter|no backup writer.*restore/isu,
    "stock backup and restore limitation");
  assert.match(guide, /re-?query.*backup.*manifest|fresh.*projection.*manifest/isu,
    "fresh backup projection before manifest extraction");

  const reviewStart = guide.indexOf('select(.type == "review_session_start"');
  assert.ok(reviewStart >= 0, "review session start selector");
  assert.ok(guide.lastIndexOf(".legal_actions[]", reviewStart) >= 0,
    "review session start comes from legal_actions");
  const reviewSection = guide.slice(guide.indexOf("## Candidate inspection and local review"));
  assert.match(reviewSection, /del\(\.operator_input\)/gu,
    "review actions remove operator_input");
  assert.match(reviewSection, /del\(\.operator_input\)[\s\S]*session_id/u,
    "review start materialization");
  assert.match(reviewSection, /del\(\.operator_input\)[\s\S]*comment_id/u,
    "review comment materialization");
  assert.match(reviewSection, /del\(\.operator_input\)[\s\S]*disposition/u,
    "review disposition materialization");

  const candidateSection = guide.slice(
    guide.indexOf("## Candidate inspection and local review"),
  );

  assert.match(reviewSection,
    /operator CLI has no query that returns the authority-observed review facts/u,
    "review preparation limitation is explicit");
  assert.match(reviewSection,
    /does not launch `review\/local`/u,
    "guide does not claim to launch review/local");
  assert.match(reviewSection,
    /Issue 84's real feature\/candidate plus separate review remains `not_run`/u,
    "issue 84 review boundary is explicit");
  assert.match(reviewSection,
    /do not claim a live or billed exercise/iu,
    "guide does not claim a live billed exercise");
  assert.doesNotMatch(reviewSection,
    /flow (?:prepare|launch) --input|flow\.predefined-flow-confirmation-decision\/v1|REVIEW_(?:SELECTION|PREPARE|LAUNCH)/u,
    "review section has no synthetic prepare or launch flow");
  assert.doesNotMatch(reviewSection,
    /catalog_fingerprint|route_snapshot|explicit_facts|time_facts|wall_time|monotonic|boot_id|clock_source|agent(?:_id|_identity)?\s*:|1{64}|2{64}/iu,
    "review section has no fabricated authority facts or placeholder identities");
  assert.match(candidateSection,
    /contract:"work\.review\/v1",subject_id:\$id/u,
    "candidate inspection queries the exact public candidate projection");
  assert.match(candidateSection,
    /REVIEW_ID="\$\(jq -er '\.review_id' [<]{3}"\$ITEM"\)/u,
    "review identity is derived from the inbox item");
  assert.match(candidateSection,
    /candidate-only inbox item is not a review/u,
    "candidate-only inbox item is rejected");
  const humanReviewSection = candidateSection.slice(
    candidateSection.indexOf('REVIEW_ID="$(jq -er'),
  );
  assert.equal(
    (humanReviewSection.match(
      /flow query --input "\$\(jq -cn --arg id "\$REVIEW_ID"/gu,
    ) ?? []).length,
    3,
    "all review projections bind REVIEW_ID",
  );
  assert.match(humanReviewSection,
    /contract:"work\.review\/v1",subject_id:\$id/u,
    "review projections use REVIEW_ID");
  assert.doesNotMatch(humanReviewSection,
    /--arg id "\$CANDIDATE_ID"|contract:"work\.review\/v1",subject_id:\$CANDIDATE_ID/u,
    "candidate ID is not used for review projections");

  const statusSection = guide.slice(
    guide.indexOf("## Status, query, watch, and authority-projected actions"),
    guide.indexOf("## Fresh runtime limits and diagnosis"),
  );
  assert.match(statusSection,
    /autonomous runner[\s\S]*operation_execute[\s\S]*delegate_execute/iu,
    "autonomous runner owns execute actions");
  assert.doesNotMatch(statusSection,
    /select\(\.type == "operation_execute"[\s\S]*flow command --input|select\(\.type == "delegate_execute"[\s\S]*flow command --input/su,
    "operator guide does not manually submit execute actions");

  const rebootSection = guide.slice(guide.indexOf("## Same-boot recovery"),
    guide.indexOf("## Candidate inspection and local review"));
  assert.match(rebootSection, /POST_REBOOT=.*post-reboot-run\.json/u,
    "post-reboot projection file");
  assert.match(rebootSection,
    /POST_REBOOT_WATERMARK[\s\S]*expected_watermark[\s\S]*POST_REBOOT/u,
    "post-reboot action uses current watermark");
  assert.match(rebootSection,
    /suspended_after_reboot[\s\S]*reboot_admission[\s\S]*POST_REBOOT/u,
    "reboot action follows fresh suspended projection");
  assert.doesNotMatch(rebootSection,
    /reboot_admission[\s\S]*recovered-run\.json/u,
    "reboot action does not use same-boot recovery file");

  assert.match(candidateSection,
    /COMPLETED="\$RECEIPTS\/completed-run\.json"[\s\S]*flow query[\s\S]*COMPLETED/u,
    "candidate path refreshes the terminal run projection");
  assert.match(candidateSection,
    /phase == "succeeded"[\s\S]*review_candidate_reference\.candidate_id/u,
    "candidate path validates success and candidate reference");
  assert.doesNotMatch(candidateSection,
    /COMPLETED=.*recovered-run\.json/u,
    "candidate path does not depend on recovery projection");

  const evidenceBoundary = guide.indexOf("## Evidence boundary and later expansion");
  const stopOffset = guide.indexOf("flow stop --json");
  assert.ok(evidenceBoundary >= 0 && stopOffset > evidenceBoundary,
    "owner stop is final cleanup, after retention guidance");
  assert.equal((guide.match(/flow stop --json/g) ?? []).length, 1,
    "owner is stopped once during final cleanup");
  assert.match(guide, /stopped/u, "cleanup verifies stopped owner");
  assert.match(guide,
    /FLOW_TMP_ROOT=.*TMPDIR[\s\S]*case "\$FLOW_ROOT" in[\s\S]*flow-operator\.\*[\s\S]*rm -rf -- "\$FLOW_ROOT"/u,
    "cleanup guards the exact mktemp Flow root prefix");
});
