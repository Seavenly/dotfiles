import { digest, freezeCanonical } from "./canonical.mjs";

export const TRACKER_PROGRESS_CONTRACT =
  "flow.operation/tracker-progress/v1";
const GITHUB_TRACKER_PROGRESS_COMPATIBILITY_CONTRACT =
  "flow.operation/tracker-progress-github/v1";
export const TRACKER_PROGRESS_MARKER = "<!-- flow.tracker-progress/v1";

const MAX_SUMMARY_LENGTH = 240;
const MAX_TOTAL = 10_000;
const trackerMutationTails = new Map();

const PROVIDERS = Object.freeze({
  github: Object.freeze({
    adapter: "github",
    name: "GitHub",
    invalidListing: "GitHub returned invalid comment observations",
    duplicateMarker: "GitHub contains duplicate Flow progress markers",
    foreignMarker: "GitHub progress marker is owned by another run",
  }),
  jira: Object.freeze({
    adapter: "jira",
    name: "Jira",
    invalidListing: "Jira returned invalid comment observations",
    duplicateMarker: "Jira contains duplicate Flow progress markers",
    foreignMarker: "Jira progress marker is owned by another run",
  }),
});

export function createTrackerProgressOperation({
  provider,
  driver,
} = {}) {
  const profile = providerProfile(provider);
  const port = normalizeDriver(driver, profile.name);
  const acceptedContracts = profile.adapter === "github"
    ? [TRACKER_PROGRESS_CONTRACT,
      GITHUB_TRACKER_PROGRESS_COMPATIBILITY_CONTRACT]
    : [TRACKER_PROGRESS_CONTRACT];
  return createProviderOperation({
    profile,
    port,
    contract: TRACKER_PROGRESS_CONTRACT,
    acceptedContracts,
  });
}

export function createTrackerProgressRegistrationBundle(entries = {}) {
  const providerEntries = createProviderEntries(entries);
  const github = providerEntries.get("github");
  return Object.freeze({
    [TRACKER_PROGRESS_CONTRACT]: createCompositeOperation(providerEntries),
    [GITHUB_TRACKER_PROGRESS_COMPATIBILITY_CONTRACT]:
      createProviderOperation({
        profile: github.profile,
        port: github.port,
        contract: GITHUB_TRACKER_PROGRESS_COMPATIBILITY_CONTRACT,
        acceptedContracts: [GITHUB_TRACKER_PROGRESS_COMPATIBILITY_CONTRACT],
      }),
  });
}

function createCompositeOperation(entries) {
  return Object.freeze({
    contract: TRACKER_PROGRESS_CONTRACT,
    classification: "reconcilable",
    validateCard(card, proposal) {
      const entry = entryForProposal(entries, proposal);
      assertTrackerOperationCardContract(card, entry.profile.adapter);
      return validateTrackerProgressCard(
        card,
        proposal,
        entry.profile.adapter,
      );
    },
    async invoke(intent) {
      return invokeTrackerProgress(entryForIntent(entries, intent), intent);
    },
    async observe(intent) {
      return observeTrackerProgress(entryForIntent(entries, intent), intent);
    },
  });
}

function createProviderEntries(entries) {
  if (!exactKeys(entries, ["github", "jira"])) {
    throw new TypeError(
      "tracker progress requires exact GitHub and Jira Adapter entries",
    );
  }
  return new Map([
    ["github", createProviderEntry("github", entries.github)],
    ["jira", createProviderEntry("jira", entries.jira)],
  ]);
}

function createProviderOperation({
  profile,
  port,
  contract,
  acceptedContracts,
}) {
  return Object.freeze({
    contract,
    provider: profile.adapter,
    classification: "reconcilable",
    validateCard(card, proposal) {
      if (!acceptedContracts.includes(card?.executor?.contract)) {
        throw new TypeError(
          "tracker progress requires its versioned operation contract",
        );
      }
      return validateTrackerProgressCard(card, proposal, profile.adapter);
    },
    async invoke(intent) {
      return invokeTrackerProgress({ profile, port }, intent);
    },
    async observe(intent) {
      return observeTrackerProgress({ profile, port }, intent);
    },
  });
}

function createProviderEntry(provider, entry) {
  if (!exactKeys(entry, ["driver"])) {
    throw new TypeError(
      `${providerProfile(provider).name} tracker progress requires an exact Adapter entry`,
    );
  }
  const profile = providerProfile(provider);
  return Object.freeze({
    profile,
    port: normalizeDriver(entry.driver, profile.name),
  });
}

function entryForProposal(entries, proposal) {
  const provider = proposal?.explicit_facts?.tracker_binding?.tracker?.system;
  const entry = entries.get(provider);
  if (!entry) {
    throw new TypeError(
      "tracker progress requires a configured provider Adapter",
    );
  }
  return entry;
}

function entryForIntent(entries, intent) {
  const provider = intent?.tracker_binding?.tracker?.system;
  const entry = entries.get(provider);
  if (!entry) {
    throw new TypeError(
      "tracker progress requires a configured provider Adapter",
    );
  }
  return entry;
}

function assertTrackerOperationCardContract(card, provider) {
  const acceptedContracts = provider === "github"
    ? [TRACKER_PROGRESS_CONTRACT,
      GITHUB_TRACKER_PROGRESS_COMPATIBILITY_CONTRACT]
    : [TRACKER_PROGRESS_CONTRACT];
  if (!acceptedContracts.includes(card?.executor?.contract)) {
    throw new TypeError(
      "tracker progress requires its versioned operation contract",
    );
  }
}

async function invokeTrackerProgress({ profile, port }, intent) {
  const request = trackerRequest(intent, profile.adapter);
  return withTrackerMutationFence(request.tracker, async () => {
    const desiredBody = renderTrackerProgress(intent, request);
    const observation = await inspectComments(
      port,
      profile,
      request.tracker,
      intent,
      desiredBody,
    );
    if (observation.conflict) {
      throw new Error(observation.conflict);
    }
    let comment;
    let mutation;
    if (observation.exact) {
      comment = observation.comment;
      mutation = "unchanged";
    } else if (observation.comment) {
      comment = await port.updateComment(
        request.tracker,
        observation.comment.id,
        desiredBody,
      );
      mutation = "updated";
    } else {
      comment = await port.createComment(request.tracker, desiredBody);
      mutation = "created";
    }
    return effectReceipt(intent, providerReceipt({
      body: desiredBody,
      comment,
      observedCommentId: observation.comment?.id ?? null,
      intent,
      mutation,
      profile,
    }));
  });
}

async function observeTrackerProgress({ profile, port }, intent) {
  const request = trackerRequest(intent, profile.adapter);
  const desiredBody = renderTrackerProgress(intent, request);
  const observation = await inspectComments(
    port,
    profile,
    request.tracker,
    intent,
    desiredBody,
  );
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
      observedCommentId: observation.comment.id,
      intent,
      mutation: "observed",
      profile,
    }));
  }
  return effectObservation(intent, "absent", {
    marker_matches: observation.markerMatches,
    observed_comment_id: observation.comment?.id ?? null,
    observed_content_sha256: observation.comment
      ? digest(observation.comment.body)
      : null,
    tracker: trackerIdentity(request.tracker),
    system: profile.adapter,
  });
}

export function validateTrackerProgressBinding(proposal) {
  const binding = proposal?.explicit_facts?.tracker_binding;
  if (!validTrackerBinding(binding)) {
    throw new TypeError(
      "tracker progress requires a confirmed feature or epic tracker binding",
    );
  }
}

export function validateTrackerProgressCard(card, proposal, provider) {
  const profile = providerProfile(provider);
  validateTrackerProgressBinding(proposal);
  const binding = proposal.explicit_facts.tracker_binding;
  const trackerProvider = binding.tracker.system;
  if (trackerProvider !== profile.adapter) {
    throw new TypeError("tracker progress requires its confirmed provider route");
  }
  if (!validProgress(card?.inputs)) {
    throw new TypeError("tracker progress update is invalid or unbounded");
  }
  if (card?.route?.adapter !== trackerProvider ||
      card.route === null || typeof card.route !== "object" ||
      Array.isArray(card.route) || Object.keys(card.route).length !== 1) {
    throw new TypeError("tracker progress requires the confirmed provider route");
  }
  const expectedClaim = {
    kind: "tracker-progress",
    id: trackerIdentity(binding.tracker),
  };
  if (!Array.isArray(card.resource_claims) ||
      card.resource_claims.length !== 1 ||
      digest(card.resource_claims[0]) !== digest(expectedClaim)) {
    throw new TypeError("tracker progress requires its exact tracker claim");
  }
  if (proposal.graph.cards.some(({ dependencies }) =>
    dependencies.includes(card.id))) {
    throw new TypeError("tracker progress cannot schedule downstream work");
  }
  const revisionTemplates = Array.isArray(proposal.revision_templates)
    ? proposal.revision_templates
    : [];
  const revisionProgressCards = revisionTemplates.flatMap(({ changes }) =>
    Array.isArray(changes?.add_cards)
      ? changes.add_cards.filter(({ executor }) =>
          isTrackerProgressContract(executor?.contract))
      : []);
  const revisionCardIds = new Set(revisionProgressCards.map(({ id }) => id));
  const baseProgressCards = proposal.graph.cards.filter(({ id, executor }) =>
    isTrackerProgressContract(executor?.contract) &&
    !revisionCardIds.has(id));
  const progressCards = [...baseProgressCards, ...revisionProgressCards];
  const sequences = progressCards.map(({ inputs }) => inputs?.sequence);
  if (new Set(sequences).size !== sequences.length) {
    throw new TypeError("tracker progress update sequences must be unique");
  }
  const trackerRevisionCount = revisionTemplates.filter(({ changes }) =>
    Array.isArray(changes?.add_cards) && changes.add_cards.some(({ executor }) =>
      isTrackerProgressContract(executor?.contract))).length;
  if (trackerRevisionCount > 1) {
    throw new TypeError(
      "tracker progress updates require one unambiguous revision path",
    );
  }
  if (revisionProgressCards.length > 0 && baseProgressCards.length > 0 &&
      Math.min(...revisionProgressCards.map(({ inputs }) => inputs.sequence)) <=
      Math.max(...baseProgressCards.map(({ inputs }) => inputs.sequence))) {
    throw new TypeError(
      "revision progress sequence must advance the base plan",
    );
  }
}

export function isTrackerProgressContract(contract) {
  return contract === TRACKER_PROGRESS_CONTRACT ||
    contract === GITHUB_TRACKER_PROGRESS_COMPATIBILITY_CONTRACT;
}

function trackerOperationContractAllowed(contract, provider) {
  return contract === TRACKER_PROGRESS_CONTRACT ||
    (provider === "github" &&
      contract === GITHUB_TRACKER_PROGRESS_COMPATIBILITY_CONTRACT);
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
  ].join("\n");
}

export function trackerIdentity(tracker) {
  if (tracker?.system === "github") {
    return `github:${tracker.owner}/${tracker.repository}#${tracker.issue_number}`;
  }
  if (tracker?.system === "jira") {
    return `jira:${tracker.project}-${tracker.issue_number}`;
  }
  throw new TypeError("tracker identity requires a supported provider");
}

export function validTrackerBinding(value) {
  return exactKeys(value, ["schema", "flow", "tracker"]) &&
    value.schema === "flow.tracker-binding/v1" &&
    ["feature", "epic"].includes(value.flow) &&
    validTracker(value.tracker);
}

export function validProgress(value) {
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

function trackerRequest(intent, provider = null) {
  const binding = intent?.tracker_binding;
  const operationContract = intent?.operation_contract;
  const trackerProvider = binding?.tracker?.system;
  if (!trackerOperationContractAllowed(operationContract, trackerProvider) ||
      intent.classification !== "reconcilable" ||
      typeof intent.run_id !== "string" || !validTrackerBinding(binding) ||
      provider !== null && binding.tracker.system !== provider ||
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

async function inspectComments(port, profile, tracker, intent, desiredBody) {
  const listing = await port.listComments(tracker);
  if (!exactKeys(listing, ["comments", "complete"]) ||
      listing.complete !== true || !Array.isArray(listing.comments) ||
      !listing.comments.every(validComment)) {
    return { conflict: profile.invalidListing, markerMatches: 0 };
  }
  const comments = listing.comments;
  const marked = comments.filter(({ body }) =>
    body.includes(TRACKER_PROGRESS_MARKER));
  if (marked.length > 1) {
    return {
      conflict: profile.duplicateMarker,
      markerMatches: marked.length,
    };
  }
  const comment = marked[0] ?? null;
  if (comment && markerOwner(comment.body) !== intent.run_id) {
    return {
      comment,
      conflict: profile.foreignMarker,
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

function providerReceipt({
  body,
  comment,
  observedCommentId,
  intent,
  mutation,
  profile,
}) {
  if (!validComment(comment) || comment.body !== body ||
      (mutation === "updated" &&
        String(comment.id) !== String(observedCommentId))) {
    throw new TypeError(`${profile.name} returned an invalid progress comment receipt`);
  }
  return freezeCanonical({
    system: profile.adapter,
    tracker: trackerIdentity(intent.tracker_binding.tracker),
    comment_id: String(comment.id),
    mutation,
    owner_run_id: intent.run_id,
    authority_watermark: intent.source_authority_watermark,
    content_sha256: digest(body),
  });
}

function validTracker(value) {
  return validGitHubTracker(value) || validJiraTracker(value);
}

function validGitHubTracker(value) {
  return exactKeys(value, ["system", "owner", "repository", "issue_number"]) &&
    value.system === "github" &&
    validPathSegment(value.owner) && validPathSegment(value.repository) &&
    Number.isSafeInteger(value.issue_number) && value.issue_number > 0;
}

function validJiraTracker(value) {
  return exactKeys(value, ["system", "project", "issue_number"]) &&
    value.system === "jira" && validJiraProject(value.project) &&
    Number.isSafeInteger(value.issue_number) && value.issue_number > 0;
}

function validTopLevelOwnership(value) {
  return exactKeys(value, ["schema", "scope", "parent_run_id"]) &&
    value.schema === "flow.run-ownership/v1" &&
    value.scope === "top_level" && value.parent_run_id === null;
}

function validJiraProject(value) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]*$/.test(value);
}

function validPathSegment(value) {
  return typeof value === "string" && ![".", ".."].includes(value) &&
    /^[A-Za-z0-9_.-]+$/.test(value);
}

function providerProfile(provider) {
  const profile = PROVIDERS[provider];
  if (!profile) throw new TypeError(`unsupported tracker provider: ${provider}`);
  return profile;
}

function normalizeDriver(driver, providerName) {
  const methods = {
    listComments: driver?.listComments,
    createComment: driver?.createComment,
    updateComment: driver?.updateComment,
  };
  if (!Object.values(methods).every((method) => typeof method === "function")) {
    throw new TypeError(`${providerName} tracker progress requires a complete driver`);
  }
  return Object.freeze({
    listComments: methods.listComments.bind(driver),
    createComment: methods.createComment.bind(driver),
    updateComment: methods.updateComment.bind(driver),
  });
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

function exactKeys(value, fields) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field));
}
