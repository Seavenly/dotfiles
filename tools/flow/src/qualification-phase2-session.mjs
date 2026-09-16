import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/**
 * In-process capability for the phase-two evidence generator's temporary
 * authority copy. It is never read from a request, environment variable, or
 * public transport frame.
 */
const SESSION_BRAND = Symbol("production-route-conformance-generation-session");

export function createProductionRouteConformanceSession({
  authorityDirectory,
  marker,
} = {}) {
  if (typeof authorityDirectory !== "string" ||
      typeof marker !== "string" || !/^[0-9a-f]{64}$/u.test(marker)) {
    throw new TypeError("production route conformance session is invalid");
  }
  return Object.freeze({
    [SESSION_BRAND]: true,
    authorityDirectory: realpathSync(resolve(authorityDirectory)),
    marker,
  });
}

export function productionRouteConformanceSessionDetails(session) {
  if (session === null || typeof session !== "object" ||
      session[SESSION_BRAND] !== true) return null;
  return {
    authorityDirectory: session.authorityDirectory,
    marker: session.marker,
  };
}

export function productionRouteConformanceSessionBinding({
  authorityDirectory,
  generationId,
  marker,
}) {
  const authorityRoot = realpathSync(resolve(authorityDirectory));
  return createHash("sha256")
    .update(Buffer.from(
      `flow.production-route-conformance-session/v1\0${authorityRoot}\0${generationId}\0${marker}`,
    ))
    .digest("hex");
}
