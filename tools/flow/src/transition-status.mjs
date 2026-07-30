import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { queryTransition } from "./transition-projection.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const projection = await queryTransition({
  configDirectory: resolve(repositoryRoot, "config/flow"),
});
process.stdout.write(`${JSON.stringify(projection, null, 2)}\n`);
