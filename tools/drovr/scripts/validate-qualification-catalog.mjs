import {
  loadQualificationCatalog,
  validateQualificationCatalog,
} from "../src/qualification-catalog.mjs";

const summary = validateQualificationCatalog(await loadQualificationCatalog());
process.stdout.write(
  `validated ${summary.scenario_count} Drovr qualification scenarios (${summary.execution_kinds.join(", ")})\n`,
);
