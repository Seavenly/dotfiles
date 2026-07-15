const GITHUB_ID = /^[a-z0-9_.-]+\/[a-z0-9_.-]+#[1-9][0-9]*$/;
const JIRA_ID = /^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/;

export function parseExternalRef(externalRef) {
  if (externalRef === null) return null;
  const separator = externalRef.indexOf(":");
  const system = externalRef.slice(0, separator);
  const id = externalRef.slice(separator + 1);
  return {
    system,
    id: system === "github" ? id.toLowerCase() : id.toUpperCase(),
  };
}

export function isCanonicalExternalRoot(externalRoot) {
  if (externalRoot === null) return true;
  if (externalRoot.system === "github") {
    return GITHUB_ID.test(externalRoot.id);
  }
  if (externalRoot.system === "jira") {
    return JIRA_ID.test(externalRoot.id);
  }
  return false;
}
