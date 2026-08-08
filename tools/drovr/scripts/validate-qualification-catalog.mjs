import {
  loadQualificationCatalog,
  validateQualificationCatalog,
} from "../src/qualification-catalog.mjs";
import {
  loadSoakPlan,
  validateSoakPlanAgainstCatalog,
} from "../src/qualification-soak.mjs";

const catalog = await loadQualificationCatalog();
const summary = validateQualificationCatalog(catalog);
const soak = validateSoakPlanAgainstCatalog(
  await loadSoakPlan(),
  catalog,
);
process.stdout.write(
  `validated ${summary.scenario_count} Drovr qualification scenarios (${summary.execution_kinds.join(", ")}); soak plan covers ${soak.scenario_count} live scenarios\n`,
);
