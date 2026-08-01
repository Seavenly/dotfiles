import { fileURLToPath } from "node:url";

import { describeDelegatedAgent } from "../../drovr/src/description.mjs";
import { digest } from "../src/canonical.mjs";

const repositoryDrovrConfigDirectory = fileURLToPath(new URL(
  "../../../config/drovr/",
  import.meta.url,
));

export function repositoryDrovrDependencies(env = process.env) {
  return {
    env: {
      ...env,
      DROVR_CONFIG_DIR: repositoryDrovrConfigDirectory,
    },
  };
}

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
