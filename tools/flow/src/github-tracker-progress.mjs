import { digest, freezeCanonical } from "./canonical.mjs";

export const TRACKER_PROGRESS_CONTRACT =
  "flow.operation/tracker-progress-github/v1";
export const TRACKER_PROGRESS_MARKER = "<!-- flow.tracker-progress/v1";

const MAX_SUMMARY_LENGTH = 240;
const MAX_TOTAL = 10_000;
const trackerMutationTails = new Map();

export function createGitHubTrackerProgressOperation({ driver } = {}) {
  if (!["listComments", "createComment", "updateComment"].every(
    (method) => typeof driver?.[method] === "function",
  )) {
    throw new TypeError("GitHub tracker progress requires a complete driver");
  }
  return Object.freeze({
    classification: "reconcilable",
    validateCard: validateTrackerProgressCard,
    async invoke(intent) {
      const request = trackerRequest(intent);
      return withTrackerMutationFence(request.tracker, async () => {
        const desiredBody = renderTrackerProgress(intent, request);
        const observation = await inspectComments(driver, intent, desiredBody);
        if (observation.conflict) {
          throw new Error(observation.conflict);
        }
        let comment;
        let mutation;
        if (observation.exact) {
          comment = observation.comment;
          mutation = "unchanged";
        } else if (observation.comment) {
          comment = await driver.updateComment(
            request.tracker,
            observation.comment.id,
            desiredBody,
          );
          mutation = "updated";
        } else {
          comment = await driver.createComment(request.tracker, desiredBody);
          mutation = "created";
        }
        return effectReceipt(intent, providerReceipt({
          body: desiredBody,
          comment,
          intent,
          mutation,
        }));
      });
    },
    async observe(intent) {
      const request = trackerRequest(intent);
      const desiredBody = renderTrackerProgress(intent, request);
      const observation = await inspectComments(driver, intent, desiredBody);
      if (observation.conflict) {
        return effectObservation(intent, "indeterminate", {
          conflict: observation.conflict,
          marker_matches: observation.markerMatches,
        });
      }
      if (observation.exact) {
        return effectObservation(intent, "present", providerReceipt({
          body: desiredBody,
          comment: observation.comment,
          intent,
          mutation: "observed",
        }));
      }
      return effectObservation(intent, "absent", {
        marker_matches: observation.markerMatches,
        observed_comment_id: observation.comment?.id ?? null,
        observed_content_sha256: observation.comment
          ? digest(observation.comment.body)
          : null,
        tracker: trackerIdentity(request.tracker),
      });
    },
  });
}

export function validateTrackerProgressCard(card, proposal) {
  const binding = proposal?.explicit_facts?.tracker_binding;
  if (!validTrackerBinding(binding)) {
    throw new TypeError(
      "tracker progress requires a confirmed feature or epic tracker binding",
    );
  }
  if (!validProgress(card?.inputs)) {
    throw new TypeError("tracker progress update is invalid or unbounded");
  }
  if (card?.route?.adapter !== "github" ||
      Object.keys(card.route).length !== 1) {
    throw new TypeError("tracker progress requires the confirmed GitHub route");
  }
  const expectedClaim = {
    kind: "tracker-progress",
    id: trackerIdentity(binding.tracker),
  };
  if (card.resource_claims.length !== 1 ||
      digest(card.resource_claims[0]) !== digest(expectedClaim)) {
    throw new TypeError("tracker progress requires its exact tracker claim");
  }
  if (proposal.graph.cards.some(({ dependencies }) =>
    dependencies.includes(card.id))) {
    throw new TypeError("tracker progress cannot schedule downstream work");
  }
  const progressCards = proposal.graph.cards.filter(
    ({ executor }) => executor?.contract === TRACKER_PROGRESS_CONTRACT,
  );
  const sequences = progressCards.map(({ inputs }) => inputs?.sequence);
  if (new Set(sequences).size !== sequences.length) {
    throw new TypeError("tracker progress update sequences must be unique");
  }
}

export function renderTrackerProgress(intent, request = trackerRequest(intent)) {
  const { progress } = request;
  return [
    `${TRACKER_PROGRESS_MARKER} owner=${intent.run_id} effect=${intent.effect_id} key=${intent.idempotency_key} -->`,
    `Flow progress - ${request.flow}`,
    progress.summary,
    `Progress: ${progress.completed}/${progress.total}`,
    `Phase: ${progress.phase}`,
    `Authority watermark: ${intent.source_authority_watermark}`,
    "",
  ].join("\n");
}

function trackerRequest(intent) {
  const binding = intent?.tracker_binding;
  if (intent?.operation_contract !== TRACKER_PROGRESS_CONTRACT ||
      intent.classification !== "reconcilable" ||
      typeof intent.run_id !== "string" || !validTrackerBinding(binding) ||
      !validTopLevelOwnership(intent.run_ownership) ||
      !validProgress(intent.operation_input)) {
    throw new TypeError(
      "tracker progress mutation requires exact top-level run authority",
    );
  }
  return {
    flow: binding.flow,
    progress: intent.operation_input,
    tracker: binding.tracker,
  };
}

async function inspectComments(driver, intent, desiredBody) {
  const comments = await driver.listComments(intent.tracker_binding.tracker);
  if (!Array.isArray(comments) || !comments.every(validComment)) {
    return { conflict: "GitHub returned invalid comment observations", markerMatches: 0 };
  }
  const marked = comments.filter(({ body }) =>
    body.includes(TRACKER_PROGRESS_MARKER));
  if (marked.length > 1) {
    return {
      conflict: "GitHub contains duplicate Flow progress markers",
      markerMatches: marked.length,
    };
  }
  const comment = marked[0] ?? null;
  if (comment && markerOwner(comment.body) !== intent.run_id) {
    return {
      comment,
      conflict: "GitHub progress marker is owned by another run",
      markerMatches: 1,
    };
  }
  return {
    comment,
    exact: comment?.body === desiredBody,
    markerMatches: marked.length,
  };
}

function effectReceipt(intent, providerReceiptValue) {
  return freezeCanonical({
    schema: "flow.effect-receipt/v1",
    effect_id: intent.effect_id,
    idempotency_key: intent.idempotency_key,
    outcome: "succeeded",
    provider_receipt: providerReceiptValue,
  });
}

function effectObservation(intent, presence, providerObservation) {
  return freezeCanonical({
    schema: "flow.effect-observation/v1",
    effect_id: intent.effect_id,
    idempotency_key: intent.idempotency_key,
    presence,
    causation: presence === "present" ? {
      effect_id: intent.effect_id,
      idempotency_key: intent.idempotency_key,
    } : null,
    provider_observation: providerObservation,
  });
}

function providerReceipt({ body, comment, intent, mutation }) {
  if (!validComment(comment)) {
    throw new TypeError("GitHub returned an invalid progress comment receipt");
  }
  return freezeCanonical({
    system: "github",
    tracker: trackerIdentity(intent.tracker_binding.tracker),
    comment_id: String(comment.id),
    mutation,
    owner_run_id: intent.run_id,
    authority_watermark: intent.source_authority_watermark,
    content_sha256: digest(body),
  });
}

function validTrackerBinding(value) {
  return exactKeys(value, ["schema", "flow", "tracker"]) &&
    value.schema === "flow.tracker-binding/v1" &&
    ["feature", "epic"].includes(value.flow) &&
    exactKeys(value.tracker, ["system", "owner", "repository", "issue_number"]) &&
    value.tracker.system === "github" &&
    validGitHubPathSegment(value.tracker.owner) &&
    validGitHubPathSegment(value.tracker.repository) &&
    Number.isSafeInteger(value.tracker.issue_number) &&
    value.tracker.issue_number > 0;
}

function validTopLevelOwnership(value) {
  return exactKeys(value, ["schema", "scope", "parent_run_id"]) &&
    value.schema === "flow.run-ownership/v1" &&
    value.scope === "top_level" && value.parent_run_id === null;
}

function validProgress(value) {
  return exactKeys(value, [
    "schema", "sequence", "phase", "summary", "completed", "total",
  ]) && value.schema === "flow.tracker-progress-update/v1" &&
    Number.isSafeInteger(value.sequence) && value.sequence > 0 &&
    ["active", "blocked", "complete"].includes(value.phase) &&
    typeof value.summary === "string" && value.summary.length > 0 &&
    value.summary.length <= MAX_SUMMARY_LENGTH && !/[\r\n]/.test(value.summary) &&
    Number.isSafeInteger(value.completed) && value.completed >= 0 &&
    Number.isSafeInteger(value.total) && value.total > 0 &&
    value.total <= MAX_TOTAL && value.completed <= value.total;
}

function trackerIdentity(tracker) {
  return `github:${tracker.owner}/${tracker.repository}#${tracker.issue_number}`;
}

async function withTrackerMutationFence(tracker, mutate) {
  const key = trackerIdentity(tracker).toLowerCase();
  const previous = trackerMutationTails.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  trackerMutationTails.set(key, current);
  await previous.catch(() => {});
  try {
    return await mutate();
  } finally {
    release();
    if (trackerMutationTails.get(key) === current) {
      trackerMutationTails.delete(key);
    }
  }
}

function markerOwner(body) {
  return body.match(/<!-- flow\.tracker-progress\/v1 owner=([^ ]+)/)?.[1] ?? null;
}

function validComment(comment) {
  return comment !== null && typeof comment === "object" &&
    ["string", "number"].includes(typeof comment.id) &&
    typeof comment.body === "string";
}

function validGitHubPathSegment(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.-]+$/.test(value);
}

function exactKeys(value, fields) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field));
}
