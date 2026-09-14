import { homedir } from "node:os";
import { join } from "node:path";

import {
  createDurableRunAuthority,
} from "../../../tools/flow/src/run-authority.mjs";
import {
  statusAutonomousFlowRuntime,
  stopAutonomousFlowRuntime,
} from "../../../tools/flow/src/flow-runtime.mjs";

const ownedAuthorities = new Map();
const runtimeAuthorities = new WeakMap();
const optionReferenceIds = new WeakMap();
let nextOptionReferenceId = 1;

/**
 * Return the host-local replacement authority root used by the normal Flow
 * composition.  The root is deliberately separate from the retained legacy
 * run roots so installing the replacement cannot make legacy state
 * authoritative.
 */
export function productionAuthorityDirectory(env = process.env) {
  const home = env.HOME ?? homedir();
  const stateHome = env.XDG_STATE_HOME ?? join(home, ".local", "state");
  return env.FLOW_AUTHORITY_DIRECTORY ?? join(stateHome, "flow");
}

/**
 * Construct (or reuse within this host process) the durable lifecycle
 * authority owned by the production composition root.
 */
export function createProductionRunAuthority({
  env = process.env,
  authorityDirectory = productionAuthorityDirectory(env),
  authorityOptions = {},
  authorityOptionsIdentitySource = undefined,
} = {}) {
  if (typeof authorityDirectory !== "string" || authorityDirectory.length === 0) {
    throw new TypeError("production FlowRuntime requires an authority directory");
  }
  const optionsIdentity = authorityOptionsIdentity(
    authorityOptionsIdentitySource ?? authorityOptions,
  );
  const existing = ownedAuthorities.get(authorityDirectory);
  if (existing !== undefined) {
    if (existing.optionsIdentity !== optionsIdentity) {
      throw new ProductionAuthorityOptionsConflictError();
    }
    existing.ownerCount += 1;
    return existing.authority;
  }
  const authority = createDurableRunAuthority({
    ...authorityOptions,
    authorityDirectory,
  });
  ownedAuthorities.set(authorityDirectory, {
    authority,
    optionsIdentity,
    ownerCount: 1,
  });
  return authority;
}

/**
 * Release one production authority lease acquired by
 * createProductionRunAuthority.  Construction uses this path before a
 * runtime has been registered in runtimeAuthorities.
 */
export function releaseProductionRunAuthority(authority) {
  for (const [directory, cached] of ownedAuthorities) {
    if (cached.authority !== authority) continue;
    cached.ownerCount -= 1;
    if (cached.ownerCount === 0) {
      ownedAuthorities.delete(directory);
      cached.authority.close();
    }
    return true;
  }
  return false;
}

export class ProductionAuthorityOptionsConflictError extends Error {
  constructor() {
    super("production authority options conflict with a retained authority");
    this.name = "ProductionAuthorityOptionsConflictError";
    this.code = "authority_options_conflict";
  }
}

export function rememberRuntimeAuthority(
  runtime,
  authority,
  { owned = false, coreRuntime = runtime } = {},
) {
  if (runtime === null || typeof runtime !== "object" ||
      authority === null || typeof authority !== "object") {
    throw new TypeError("FlowRuntime authority ownership requires objects");
  }
  runtimeAuthorities.set(runtime, { authority, owned, coreRuntime });
  return runtime;
}

export function closeOwnedFlowRuntime(runtime) {
  const entry = runtimeAuthorities.get(runtime);
  if (entry === undefined) return false;
  runtimeAuthorities.delete(runtime);
  stopAutonomousFlowRuntime(entry.coreRuntime);
  if (!entry.owned || typeof entry.authority.close !== "function") return false;
  if (releaseProductionRunAuthority(entry.authority)) return true;
  entry.authority.close();
  return true;
}

export function flowRuntimeAuthority(runtime) {
  return runtimeAuthorities.get(runtime)?.authority ?? null;
}

/**
 * Return only whether this production runtime currently owns the durable
 * mutation fence. The authority object and its database remain private.
 */
export function flowRuntimeMutationAuthority(runtime) {
  return flowRuntimeAuthority(runtime)?.mutationAuthority === true;
}

export function statusFlowRuntime(runtime) {
  const entry = runtimeAuthorities.get(runtime);
  return statusAutonomousFlowRuntime(entry?.coreRuntime ?? runtime);
}

function authorityOptionsIdentity(options) {
  if (options === null || typeof options !== "object" ||
      Array.isArray(options)) {
    return "{}";
  }
  return JSON.stringify(Object.fromEntries(
    Object.entries(options)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, optionIdentityValue(value)]),
  ));
}

function optionIdentityValue(value) {
  if (value === null || typeof value !== "object" && typeof value !== "function") {
    if (typeof value === "number") {
      if (Number.isNaN(value)) return ["number", "NaN"];
      if (Object.is(value, -0)) return ["number", "-0"];
    }
    if (typeof value === "undefined") return ["undefined"];
    if (typeof value === "bigint") return ["bigint", value.toString()];
    return [typeof value, value];
  }
  let referenceId = optionReferenceIds.get(value);
  if (referenceId === undefined) {
    referenceId = `ref:${nextOptionReferenceId++}`;
    optionReferenceIds.set(value, referenceId);
  }
  return [typeof value, referenceId];
}
