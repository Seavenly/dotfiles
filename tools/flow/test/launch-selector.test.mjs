import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { resolveLaunchPolicy } from "../src/launch-selector.mjs";

const policyPath = fileURLToPath(
  new URL("../../../config/flow/launch-policy.v1.json", import.meta.url),
);
const releaseManifestPath = fileURLToPath(
  new URL("../../../config/flow/release-manifest.v1.json", import.meta.url),
);

test("repeated selection keeps the frozen legacy implementation as the default", async () => {
  const environment = {
    homeDirectory: "/test/home",
    stateDirectory: "/test/state",
  };
  const first = await resolveLaunchPolicy({ policyPath, ...environment });
  const second = await resolveLaunchPolicy({ policyPath, ...environment });

  assert.deepEqual(second, first);
  assert.equal(first.implementation, "legacy-claude/v1");
  assert.deepEqual(first.authority_root_spec, {
    base: "home",
    path: ".agent-teams",
  });
  assert.equal(first.authority_root, "/test/home/.agent-teams");
  assert.match(first.policy_watermark, /^sha256:[0-9a-f]{64}$/);

  await assert.rejects(
    resolveLaunchPolicy({
      policyPath,
      requestedImplementation: "flow-runtime/v1",
      ...environment,
    }),
    /replacement launch is disabled/,
  );
});

test("explicit dark opt-in selects the exact qualified feature verify route", async () => {
  const selection = await resolveLaunchPolicy({
    policyPath,
    releaseManifestPath,
    requestedImplementation: "flow-runtime/v1",
    darkOptIn: {
      schema: "flow.dark-opt-in/v1",
      release_id: "flow-release-1.0-dark/v1",
      purpose: "sacrificial_qualification",
    },
    route: {
      flow: "feature",
      mode: "verify",
    },
    homeDirectory: "/test/home",
    stateDirectory: "/test/state",
  });

  assert.equal(selection.schema, "flow.launch-selection/v1");
  assert.equal(selection.implementation, "flow-runtime/v1");
  assert.equal(selection.release_id, "flow-release-1.0-dark/v1");
  assert.equal(selection.scope, "dark_sacrificial");
  assert.deepEqual(selection.route, {
    flow: "feature",
    mode: "verify",
  });
  assert.equal(selection.normal_use_authorized, false);
  assert.equal(selection.remote_mutations_authorized, false);
});

test("dark opt-in returns a typed disabled outcome for feature test", async () => {
  await assert.rejects(
    resolveLaunchPolicy({
      policyPath,
      releaseManifestPath,
      requestedImplementation: "flow-runtime/v1",
      darkOptIn: {
        schema: "flow.dark-opt-in/v1",
        release_id: "flow-release-1.0-dark/v1",
        purpose: "sacrificial_qualification",
      },
      route: {
        flow: "feature",
        mode: "test",
      },
      homeDirectory: "/test/home",
      stateDirectory: "/test/state",
    }),
    (error) => {
      assert.equal(error.schema, "flow.launch-rejection/v1");
      assert.equal(error.code, "route_disabled");
      assert.equal(error.outcome, "disabled");
      assert.deepEqual(error.route, {
        flow: "feature",
        mode: "test",
      });
      return true;
    },
  );
});

test("explicit dark opt-in selects the exact local review route", async () => {
  const selection = await resolveLaunchPolicy({
    policyPath,
    releaseManifestPath,
    requestedImplementation: "flow-runtime/v1",
    darkOptIn: {
      schema: "flow.dark-opt-in/v1",
      release_id: "flow-release-1.0-dark/v1",
      purpose: "sacrificial_qualification",
    },
    route: {
      flow: "review",
      mode: "local",
    },
    homeDirectory: "/test/home",
    stateDirectory: "/test/state",
  });

  assert.deepEqual(selection.route, {
    flow: "review",
    mode: "local",
  });
  assert.equal(selection.scope, "dark_sacrificial");
});

const disabledOrUnsupportedRoutes = [
  [{ flow: "feature", mode: "test" }, "disabled"],
  [{ flow: "feature", mode: "mixed" }, "disabled"],
  [{ flow: "spike", mode: "quick" }, "disabled"],
  [{ flow: "spike", mode: "deep" }, "disabled"],
  [{ flow: "epic", mode: "default" }, "disabled"],
  [{ flow: "review", mode: "github" }, "unsupported"],
  [{ flow: "tracker", mode: "github" }, "unsupported"],
  [{ flow: "tracker", mode: "jira" }, "unsupported"],
  [{ flow: "forge", mode: "default" }, "unsupported"],
  [{ flow: "publication", mode: "default" }, "unsupported"],
  [{ flow: "merge", mode: "default" }, "unsupported"],
  [{ flow: "push", mode: "default" }, "unsupported"],
  [{ flow: "remote", mode: "mutation" }, "unsupported"],
  [{ flow: "unknown", mode: "unknown" }, "unsupported"],
];

for (const [route, expectedOutcome] of disabledOrUnsupportedRoutes) {
  test(`dark opt-in classifies ${route.flow}/${route.mode} as ${expectedOutcome}`, async () => {
    await assert.rejects(
      resolveLaunchPolicy(darkSelection({ route })),
      (error) => {
        assert.equal(error.schema, "flow.launch-rejection/v1");
        assert.equal(error.outcome, expectedOutcome);
        assert.equal(
          error.code,
          expectedOutcome === "disabled" ? "route_disabled" : "route_unsupported",
        );
        assert.deepEqual(error.route, route);
        return true;
      },
    );
  });
}

test("dark opt-in rejects an unknown release scope", async () => {
  await assert.rejects(
    resolveLaunchPolicy(darkSelection({
      darkOptIn: {
        schema: "flow.dark-opt-in/v1",
        release_id: "flow-release-unknown/v1",
        purpose: "sacrificial_qualification",
      },
    })),
    (error) => {
      assert.equal(error.schema, "flow.launch-rejection/v1");
      assert.equal(error.code, "invalid_dark_opt_in");
      assert.equal(error.outcome, "unsupported");
      return true;
    },
  );
});

test("dark opt-in rejects a malformed route with a schema-valid typed outcome", async () => {
  await assert.rejects(
    resolveLaunchPolicy(darkSelection({ route: { flow: "feature" } })),
    (error) => {
      assert.equal(error.schema, "flow.launch-rejection/v1");
      assert.equal(error.code, "invalid_route");
      assert.equal(error.outcome, "unsupported");
      assert.equal(error.route, null);
      assert.deepEqual(error.rejection, {
        schema: "flow.launch-rejection/v1",
        operation: "launch",
        code: "invalid_route",
        outcome: "unsupported",
        reason: "dark sacrificial launch requires one exact flow and mode route",
        route: null,
        legal_actions: [],
      });
      return true;
    },
  );
});

test("test scope requires its exact new dark manifest and keeps mixed and remote routes closed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "flow-test-launch-selection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = JSON.parse(await readFile(releaseManifestPath, "utf8"));
  manifest.release_id = "flow-release-test-selector-fixture/v1";
  manifest.supported_routes.push({ flow: "feature", mode: "test" });
  manifest.disabled_routes = manifest.disabled_routes.filter(route => !(route.flow === "feature" && route.mode === "test"));
  manifest.dark_opt_in.release_id = manifest.release_id;
  manifest.dark_opt_in.routes = manifest.supported_routes.map(({ flow, mode }) => ({ flow, mode }));
  const bytes = `${JSON.stringify(manifest)}\n`;
  const policy = JSON.parse(await readFile(policyPath, "utf8"));
  policy.implementations["flow-runtime/v1"].dark_opt_in.manifest_sha256 = createHash("sha256").update(bytes).digest("hex");
  const copiedManifest = join(root, "release-manifest.v1.json");
  const copiedPolicy = join(root, "launch-policy.v1.json");
  await writeFile(copiedManifest, bytes);
  await writeFile(copiedPolicy, JSON.stringify(policy));
  const selection = {
    ...darkSelection({ route: { flow: "feature", mode: "test" } }),
    policyPath: copiedPolicy,
    releaseManifestPath: copiedManifest,
    darkOptIn: { schema: "flow.dark-opt-in/v1", release_id: manifest.release_id, purpose: "sacrificial_qualification" },
  };
  const admitted = await resolveLaunchPolicy(selection);
  assert.deepEqual(admitted.route, { flow: "feature", mode: "test" });
  assert.equal(admitted.normal_use_authorized, false);
  assert.equal(admitted.remote_mutations_authorized, false);
  await assert.rejects(resolveLaunchPolicy({ ...selection, darkOptIn: darkSelection().darkOptIn }), { code: "invalid_dark_opt_in" });
  for (const route of [{ flow: "feature", mode: "mixed" }, { flow: "remote", mode: "mutation" }]) {
    await assert.rejects(resolveLaunchPolicy({ ...selection, route }), error => error.schema === "flow.launch-rejection/v1" && ["route_disabled", "route_unsupported"].includes(error.code));
  }
  await writeFile(copiedManifest, `${bytes} `);
  await assert.rejects(resolveLaunchPolicy(selection), { code: "dark_opt_in_unqualified" });
});

function darkSelection({
  route,
  darkOptIn = {
    schema: "flow.dark-opt-in/v1",
    release_id: "flow-release-1.0-dark/v1",
    purpose: "sacrificial_qualification",
  },
} = {}) {
  return {
    policyPath,
    releaseManifestPath,
    requestedImplementation: "flow-runtime/v1",
    darkOptIn,
    route,
    homeDirectory: "/test/home",
    stateDirectory: "/test/state",
  };
}
