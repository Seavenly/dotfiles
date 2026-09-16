import { createHash } from "node:crypto";
import { fstatSync, readSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

const SESSION_DESCRIPTOR = 3;
const SESSION_PROCESS_ENV = "FLOW_PRODUCTION_ROUTE_CONFORMANCE_PROCESS";
const SESSION_SCHEMA = "flow.production-route-conformance-process-session/v1";
const MAX_SESSION_BYTES = 4096;

/**
 * Read the generator-owned phase-two process capability. The capability is
 * inherited on an already-open file descriptor, not accepted through the
 * public runtime constructor, a request, or environment-carried secret.
 */
export function inheritedProductionRouteConformanceSession() {
  if (process.env[SESSION_PROCESS_ENV] !== "1") return null;
  try {
    const stats = fstatSync(SESSION_DESCRIPTOR);
    if (!stats.isFile() || stats.size < 1 || stats.size > MAX_SESSION_BYTES) {
      return null;
    }
    const bytes = Buffer.alloc(stats.size);
    const length = readSync(SESSION_DESCRIPTOR, bytes, 0, bytes.length, 0);
    if (length !== bytes.length) return null;
    const session = JSON.parse(bytes.toString("utf8"));
    if (session?.schema !== SESSION_SCHEMA ||
        typeof session.authority_directory !== "string" ||
        typeof session.marker !== "string" ||
        !/^[0-9a-f]{64}$/u.test(session.marker)) {
      return null;
    }
    return Object.freeze({
      authorityDirectory: realpathSync(resolve(session.authority_directory)),
      marker: session.marker,
    });
  } catch {
    return null;
  }
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

export function productionRouteConformanceSessionBytes({
  authorityDirectory,
  marker,
}) {
  const authorityRoot = realpathSync(resolve(authorityDirectory));
  if (typeof marker !== "string" || !/^[0-9a-f]{64}$/u.test(marker)) {
    throw new TypeError("production route conformance marker is invalid");
  }
  return Buffer.from(`${JSON.stringify({
    schema: SESSION_SCHEMA,
    authority_directory: authorityRoot,
    marker,
  })}\n`);
}
