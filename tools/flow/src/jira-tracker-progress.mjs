import {
  createTrackerProgressOperation,
} from "./tracker-progress.mjs";

export function createJiraTrackerProgressOperation({ driver } = {}) {
  return createTrackerProgressOperation({ provider: "jira", driver });
}
