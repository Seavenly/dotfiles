import { parseExternalRef } from "./external-root.mjs";

const MARKER = "<!-- agent-flow-epic-progress -->";

export class ExternalRootAdapter {
  constructor({ github = null, jira = null } = {}) {
    this.drivers = { github, jira };
  }

  async upsertProgress({ externalRef, progress }) {
    const root = parseExternalRef(externalRef);
    if (!root) throw new Error("epic progress requires an external root");
    const driver = this.drivers[root.system];
    if (!driver) throw new Error(`no ${root.system} external-root driver is configured`);
    const body = renderEpicProgress(progress);
    const comments = await driver.listComments(root);
    const existing = comments.filter(({ body: text }) => text.includes(MARKER));
    if (existing.length > 1) throw new Error("external root has duplicate Agent Flow progress comments");
    if (existing[0]?.body === body) return { changed: false, id: existing[0].id };
    if (existing[0]) {
      await driver.updateComment(root, existing[0].id, body);
      return { changed: true, id: existing[0].id };
    }
    return { changed: true, id: await driver.createComment(root, body) };
  }
}

export function renderEpicProgress(progress) {
  const counts = ["complete", "running", "blocked", "review"]
    .map((name) => `${name}: ${Number(progress[name] ?? 0)}`)
    .join(" | ");
  return `${MARKER}\nAgent Flow epic progress - ${counts}\nRun: ${progress.run_id}\n`;
}
