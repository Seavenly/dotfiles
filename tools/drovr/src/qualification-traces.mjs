import { readFile } from "node:fs/promises";

import { COMPATIBILITY_FEATURES } from "./compatibility.mjs";
import { validateTrace } from "./trace.mjs";

const FIXTURES = new URL("../qualification/traces.v1.json", import.meta.url);

export async function loadTraceFixtures() {
  const bundle = JSON.parse(await readFile(FIXTURES, "utf8"));
  if (
    bundle.schema !== "drovr.harness-trace-fixtures/v1" ||
    bundle.version !== 1 ||
    bundle.origin?.kind !== "synthetic_semantic_fixture" ||
    bundle.origin?.captured !== false ||
    typeof bundle.origin?.source_commit !== "string"
  ) {
    throw new Error("unsupported Drovr trace fixture bundle");
  }
  if (!Array.isArray(bundle.fixtures)) throw new Error("trace fixture bundle is incomplete");
  return bundle.fixtures.map((fixture) => {
    if (
      typeof fixture?.id !== "string" ||
      !["claude", "codex"].includes(fixture.harness) ||
      !Array.isArray(fixture.coverage) ||
      !Array.isArray(fixture.steps)
    ) {
      throw new Error("trace fixture is incomplete");
    }
    const trace = structuredClone(fixture.trace);
    trace.provenance = {
      ...trace.provenance,
      capture: bundle.origin.kind,
      source_commit: bundle.origin.source_commit,
      compatibility: {
        schema: "drovr.compatibility/v1",
        facts: {
          drovr: "drovr.semantic-harness/v1",
          herdr: trace.provenance.herdr,
          harness: fixture.harness === "claude"
            ? trace.provenance.claude
            : trace.provenance.codex,
          integration: bundle.origin.compatibility.integrations[fixture.harness],
          adapters: [
            bundle.origin.compatibility.replay_adapter,
            bundle.origin.compatibility.transcript_adapters[fixture.harness],
          ],
          features: [...COMPATIBILITY_FEATURES],
        },
      },
    };
    validateTrace(trace);
    if (trace.scenario_id !== fixture.id) {
      throw new Error(`trace fixture id mismatch: ${fixture.id}`);
    }
    return { ...structuredClone(fixture), trace };
  });
}

export async function loadTraceFixture(id) {
  const fixture = (await loadTraceFixtures()).find(({ id: candidate }) => candidate === id);
  if (!fixture) throw new Error(`unknown trace fixture: ${id}`);
  return fixture;
}
