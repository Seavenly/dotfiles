import { digest, isPlainRecord } from "./canonical.mjs";
import { directDescriptionIssue } from "./execution-contract.mjs";

export const READ_ONLY_SIBLING_POLICY_SCHEMA = "flow.read-only-sibling-policy/v1";
const RESEARCH_POLICY = "flow.research-cohort-policy/v1";
const LENS_CARDS = ["review-lens-security", "review-lens-correctness"];

/** A closed opt-in, never a scheduler capacity setting or a resource grant. */
export function readOnlySiblingPolicyIssue(policy) {
  if (policy?.schema === RESEARCH_POLICY) return isPlainRecord(policy) && Object.keys(policy).sort().join(",") === "max_in_flight,schema" && [1, 2].includes(policy.max_in_flight) ? null : "invalid_read_only_sibling_policy";
  if (!isPlainRecord(policy) || Object.keys(policy).sort().join(",") !== "card_ids,max_in_flight,schema" ||
      policy.schema !== READ_ONLY_SIBLING_POLICY_SCHEMA || ![1, 2].includes(policy.max_in_flight) ||
      !Array.isArray(policy.card_ids) || policy.card_ids.length < 1 || policy.card_ids.length > 2 ||
      new Set(policy.card_ids).size !== policy.card_ids.length ||
      policy.card_ids.some(id => !LENS_CARDS.includes(id)) ||
      policy.max_in_flight > policy.card_ids.length) return "invalid_read_only_sibling_policy";
  return null;
}

/** Compiler-owned provenance and observed resource facts stay separate from caller policy text. */
export function readOnlySiblingPlanIssue(plan, authority) {
  const policy = plan?.execution_policy;
  const issue = readOnlySiblingPolicyIssue(policy);
  if (issue) return issue;
  const research = policy.schema === RESEARCH_POLICY;
  if (authority?.kind !== "predefined" || authority.definition?.id !== (research ? "spike/v3" : "review/v1") ||
      authority.definition?.contract !== (research ? "flow.definition/spike/v3" : "flow.definition/review/v1")) return "untrusted_read_only_sibling_policy";
  const binding = authority.required_authorities?.find(value => value.id === "resource:facts");
  if (binding?.contract !== "flow.resource-authority/v1" || binding.observation_input?.fact !== "resource_claims" ||
      !["available", "present"].includes(binding.observation?.status) ||
      !binding.provider_identity || !binding.observation?.watermark) return "read_only_sibling_authority_unavailable";
  let sharedClaim;
  const members = siblingCardIds(plan);
  if (!members.length || research && members.some(id => !/^deep-angle-[12]-cycle-[12]$/u.test(id))) return "ineligible_read_only_sibling";
  for (const id of members) {
    const card = plan.cards?.find(value => value.id === id);
    const description = card?.inputs?.description;
    if (card?.executor?.kind !== "delegate" || card.executor.contract !== "flow.delegated-agent-port/v1" ||
        (research ? card.inputs?.task_inputs?.flow !== "spike/v3" || card.inputs.task_inputs.role !== "angle" || card.dependencies?.some(id => members.includes(id)) : card.dependencies?.length !== 0) || card.limits?.max_attempts !== 1 ||
        directDescriptionIssue(description) !== null || description.launch.capability !== "read-only" ||
        card.inputs.managed_agent !== undefined || card.inputs.fallback !== undefined ||
        card.route?.description_digest !== description.description_digest ||
        card.route?.configuration_watermark !== description.watermark.content_sha256 ||
        card.route?.launch_comparison_key !== description.comparison_keys.launch) return "ineligible_read_only_sibling";
    const references = card.inputs.resource_references;
    const claims = card.resource_claims;
    if (references?.length !== 1 || claims?.length !== 1) return "ineligible_read_only_sibling_resource";
    const reference = references[0], claim = claims[0];
    if (!isPlainRecord(reference) || !isPlainRecord(claim) || reference.kind !== "workspace" || reference.authority !== "WorkspaceAuthority" ||
        reference.contract !== "work.workspace/v1" || reference.access !== "read_only" ||
        reference.authority_binding_id !== "resource:facts" || claim.kind !== "workspace" ||
        reference.subject_id !== claim.id || reference.generation !== claim.generation ||
        reference.mutation_epoch !== claim.mutation_epoch || reference.fingerprint !== claim.fingerprint ||
        !Number.isSafeInteger(claim.generation) || claim.generation < 1 ||
        !Number.isSafeInteger(claim.mutation_epoch) || claim.mutation_epoch < 0 ||
        !/^sha256:[0-9a-f]{64}$/u.test(claim.fingerprint ?? "") ||
        sharedClaim !== undefined && digest(claim) !== sharedClaim) return "ineligible_read_only_sibling_resource";
    sharedClaim = digest(claim);
  }
  return null;
}

/** Used by projection and kernel. Every recorded unresolved intent consumes a slot. */
export function canAdmitReadOnlySibling({ plan, authority, phase, intents, receipts, observations }, cardId) {
  if (phase !== "active" || readOnlySiblingPlanIssue(plan, authority) !== null) return false;
  const policy = plan.execution_policy;
  if (!siblingCardIds(plan).includes(cardId) || intents.some(intent => intent.card_id === cardId)) return false;
  let active = 0;
  for (const intent of intents) {
    if (receipts.has(intent.effect_id)) continue;
    const card = plan.cards.find(value => value.id === intent.card_id);
    const observation = observations.get(intent.effect_id);
    if (intent.effect_kind !== "delegate" || !siblingCardIds(plan).includes(intent.card_id) ||
        policy.schema === RESEARCH_POLICY && card?.inputs?.task_inputs?.cycle !== plan.cards.find(value => value.id === cardId)?.inputs?.task_inputs?.cycle ||
        !isPlainRecord(intent.route_binding) || !Array.isArray(intent.resource_claims) ||
        !isPlainRecord(intent.delegate_input?.description) || !Array.isArray(intent.delegate_input?.resource_references) ||
        intent.managed_agent_binding !== null || digest(intent.route_binding) !== digest(card.route) ||
        digest(intent.resource_claims) !== digest(card.resource_claims) ||
        digest(intent.delegate_input?.description) !== digest(card.inputs.description) ||
        digest(intent.delegate_input?.resource_references) !== digest(card.inputs.resource_references) ||
        observation !== undefined) return false;
    active += 1;
  }
  return active < policy.max_in_flight;
}

/** Read-only sharing still requires the current WorkspaceAuthority generation and fingerprint. */
export function readOnlySiblingWorkspaceIssue(projection, claim) {
  if (projection?.schema !== "work.workspace-projection/v1" || projection.subject_id !== claim.id) return "workspace_claim_missing";
  if (projection.generation !== claim.generation || projection.mutation_epoch !== claim.mutation_epoch ||
      digest({ git: projection.git }) !== claim.fingerprint) return "workspace_claim_stale";
  if (projection.taint !== null || projection.claims?.length > 0) return "workspace_claim_conflict";
  return null;
}

export function siblingCardIds(plan) {
  return plan?.execution_policy?.schema === RESEARCH_POLICY
    ? (plan.cards ?? []).filter(card => card.inputs?.task_inputs?.flow === "spike/v3" && card.inputs.task_inputs.role === "angle").map(card => card.id)
    : plan?.execution_policy?.card_ids ?? [];
}
