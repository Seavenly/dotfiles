import {
  createTrackerProgressOperation,
  renderTrackerProgress,
  trackerIdentity,
  TRACKER_PROGRESS_CONTRACT,
  TRACKER_PROGRESS_MARKER,
  validateTrackerProgressBinding,
  validateTrackerProgressCard,
} from "./tracker-progress.mjs";

export const GITHUB_TRACKER_PROGRESS_COMPATIBILITY_CONTRACT =
  "flow.operation/tracker-progress-github/v1";

export {
  renderTrackerProgress,
  trackerIdentity,
  TRACKER_PROGRESS_CONTRACT,
  TRACKER_PROGRESS_MARKER,
  validateTrackerProgressBinding,
  validateTrackerProgressCard,
};

export function createGitHubTrackerProgressOperation({ driver } = {}) {
  return createTrackerProgressOperation({ provider: "github", driver });
}

export function createGitHubTrackerProgressCompatibilityOperation({ driver } = {}) {
  return createTrackerProgressOperation({
    provider: "github",
    driver,
    contract: GITHUB_TRACKER_PROGRESS_COMPATIBILITY_CONTRACT,
  });
}
