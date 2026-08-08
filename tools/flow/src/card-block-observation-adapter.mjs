import { digest, freezeCanonical } from "./canonical.mjs";

export function observeCardBlock({ card_id: cardId, block }) {
  const evidence = {
    adapter_contract: "flow.adapter/card-block-observation/v1",
    validator_contract: "flow.validator/card-block-observation/v1",
    card_id: cardId,
    block,
  };
  return freezeCanonical({
    schema: "flow.card-block-observation/v1",
    ...evidence,
    evidence_digest: digest(evidence),
  });
}

export const CardBlockObservationAdapter = Object.freeze({
  observe: observeCardBlock,
});
