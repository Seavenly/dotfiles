import { readFile } from "node:fs/promises";

import { validateTrace } from "./trace.mjs";

const FIXTURES = new URL("../qualification/traces.v1.json", import.meta.url);

export async function loadTraceFixtures() {
  const bundle = JSON.parse(await readFile(FIXTURES, "utf8"));
  if (bundle.schema !== "drovr.harness-trace-fixtures/v1" || bundle.version !== 1) {
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
    validateTrace(fixture.trace);
    if (fixture.trace.scenario_id !== fixture.id) {
      throw new Error(`trace fixture id mismatch: ${fixture.id}`);
    }
    return structuredClone(fixture);
  });
}

export async function loadTraceFixture(id) {
  const fixture = (await loadTraceFixtures()).find(({ id: candidate }) => candidate === id);
  if (!fixture) throw new Error(`unknown trace fixture: ${id}`);
  return fixture;
}
