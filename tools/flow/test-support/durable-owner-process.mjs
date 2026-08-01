import { createFlowRuntime } from "../src/flow-runtime.mjs";
import { createDurableRunAuthority } from "../src/run-authority.mjs";
import {
  confirmedLaunchRequest,
  dynamicCheckpointProposal,
} from "./dynamic-checkpoint.mjs";
import { fixedHostIdentity } from "./fixed-host-identity.mjs";

const [authorityDirectory] = process.argv.slice(2);
const authority = createDurableRunAuthority({
  authorityDirectory,
  hostIdentityAdapter: fixedHostIdentity("boot-a", "owner-process"),
});
const runtime = createFlowRuntime({ runAuthority: authority });
const prepared = runtime.prepare(dynamicCheckpointProposal());
const launch = runtime.launch(confirmedLaunchRequest(prepared));

process.send({
  runId: launch.run_id,
  projection: runtime.query({ run_id: launch.run_id }),
});

process.on("message", (message) => {
  if (message !== "close") return;
  authority.close();
  process.exit(0);
});
