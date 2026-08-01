import { describeDelegatedAgent } from "../../drovr/src/description.mjs";
import { digest } from "../src/canonical.mjs";

export async function supportedDescription(request, dependencies) {
  const description = structuredClone(
    await describeDelegatedAgent(request, dependencies),
  );
  for (const feature of description.feature_advertisement.features) {
    feature.availability = "supported";
  }
  rebindDescriptionDigest(description);
  return description;
}

export function rebindDescriptionDigest(description) {
  const { description_digest: _digest, legal_actions: _actions, ...identity } =
    description;
  description.description_digest = digest(identity);
}
