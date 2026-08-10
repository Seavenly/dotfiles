import {
  createTrackerProgressOperation,
  renderTrackerProgress as renderSharedTrackerProgress,
  trackerIdentity as sharedTrackerIdentity,
  TRACKER_PROGRESS_MARKER as SHARED_TRACKER_PROGRESS_MARKER,
  validateTrackerProgressBinding as validateSharedTrackerProgressBinding,
  validateTrackerProgressCard as validateSharedTrackerProgressCard,
} from "./tracker-progress.mjs";

export const GITHUB_TRACKER_PROGRESS_COMPATIBILITY_CONTRACT =
  "flow.operation/tracker-progress-github/v1";
export const TRACKER_PROGRESS_CONTRACT =
  GITHUB_TRACKER_PROGRESS_COMPATIBILITY_CONTRACT;
export const TRACKER_PROGRESS_MARKER = SHARED_TRACKER_PROGRESS_MARKER;

export const renderTrackerProgress = renderSharedTrackerProgress;
export const trackerIdentity = sharedTrackerIdentity;

export function validateTrackerProgressBinding(proposal) {
  validateSharedTrackerProgressBinding(proposal);
  if (proposal.explicit_facts.tracker_binding.tracker.system !== "github") {
    throw new TypeError(
      "GitHub tracker progress requires a confirmed GitHub tracker binding",
    );
  }
}

export function validateTrackerProgressCard(card, proposal) {
  return validateSharedTrackerProgressCard(card, proposal, "github");
}

export function createGitHubTrackerProgressOperation({ driver } = {}) {
  return createTrackerProgressOperation({ provider: "github", driver });
}
