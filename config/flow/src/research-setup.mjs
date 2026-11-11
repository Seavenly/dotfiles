import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { digest } from '../../../tools/flow/src/canonical.mjs';
import { executableIdentity } from '../../../tools/flow/src/direct-delegated-agent-port.mjs';
import { codexExecutionAdapter } from '../../../tools/flow/src/codex-execution-adapter.mjs';
import { discoverInitializedClients, readRunJson } from './project-run-state.mjs';
import { selectInitCodex } from './init-codex-selection.mjs';
import { projectGit } from './project-check-presets.mjs';
import { resolveProductionGitIdentity } from './production-direct-commit.mjs';
import { terminalText } from './project-run-view.mjs';
import { provisionLocalClient } from './local-client-provisioning.mjs';
const runtimeRoot=realpathSync(resolve(dirname(fileURLToPath(import.meta.url)),'../../..'));
const fail=message=>{throw new Error(message);};

function retainedCheck(client) {
 const module=readFileSync(join(client.directory,'trusted-owner.mjs'),'utf8');
 const match=/\nconst featureTestCheck = ([^\n]+);\nexport function createFlowRuntime/.exec(module);
 if(!match) fail('Original trusted client does not expose its exact retained check selection; use its original setup.');
 return match[1]==='undefined'?undefined:JSON.parse(match[1]);
}
function canonicalResearchState(path) {
 const selected=resolve(path);
 for(let current=selected;;current=dirname(current)) {
  let stat;
  try { stat=lstatSync(current); } catch(error) { if(error.code!=="ENOENT")throw error; }
  if(stat&&(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(current)!==current))fail("Research state must retain canonical directory ancestry; aliases and broken paths are unsupported.");
  if(dirname(current)===current)break;
 }
 return selected;
}
export function createResearchSetupPlan(options,{env=process.env,cwd=process.cwd()}={}) {
 if(!/^v22\./.test(process.version)) fail('Research setup requires Node 22.');
 for(const flag of ['--summary','--acceptance','--brief','--kind','--tool-executable','--python-runner','--test-directory','--test-pattern','--reconfigure-check']) if(options[flag] || flag==='--acceptance'&&options.acceptance?.length) fail('Research setup uses no feature brief, project type or checker. Select --purpose research separately.');
 if(options.extraExecutables?.length||options.pins?.length||options['--client-link']) fail('Research setup preserves existing tools and links. Use the returned immutable client path.');
 const repository=realpathSync(projectGit(realpathSync(resolve(cwd,options['--repository']??'.')),['rev-parse','--show-toplevel']).trim());
 if(projectGit(repository,['status','--porcelain']).length) fail('Choose an existing clean Git project; preserve dirty work before setup.');
 const stateHome=env.FLOW_LOCAL_CLIENT_STATE_HOME??env.XDG_STATE_HOME??join(env.HOME??homedir(),'.local/state');
 if(!isAbsolute(stateHome)||stateHome===repository||stateHome.startsWith(repository+'/')) fail('Choose an absolute private state directory outside the project.');
 canonicalResearchState(stateHome);
 const profile=join(stateHome,'flow-local',digest(repository).slice(7,31));
 const codex=selectInitCodex({repository,profilePath:join(profile,'profile.json'),explicitPath:options['--codex-executable'],env});
 let selected,check,gitIdentity;
 if(existsSync(join(profile,'profile.json'))) {
  const clients=discoverInitializedClients({repository,client:options['--client'],env,cwd});
  if(clients.length!==1) fail('Several initialized clients exist. Select --client DIRECTORY explicitly; no client or check was changed.');
  selected=clients[0]; check=retainedCheck(selected); gitIdentity=selected.pilot.local_client.git_identity;
 } else {
  if(options['--client']) fail('No original client exists at that selection.');
  gitIdentity=resolveProductionGitIdentity(repository,env);
 }
 return {schema:'flow.project-init-selection/v1',purpose:'research',repository,git_head:projectGit(repository,['rev-parse','HEAD']).trim(),runtime_root:runtimeRoot,node:realpathSync(process.execPath),git_identity:gitIdentity,codex_executable:codex,
  selected_client:selected?.directory??null,selected_client_digest:selected?.client_digest??null,selected_pilot_digest:selected?.pilot_digest??null,retained_check:check??null,retained_check_digest:check?digest(check):null,
  setup:{state_home:stateHome,authority_directory:join(profile,'authority'),upgrade_runtime:options['--upgrade-runtime']??null},
  execution_trust:'supervised-native-cli',trust_disclosure:'Official CLI requested read-only permissions and ambient startup remain operator-supervised, not independently enforced.',project_tests:'not_run',owner_started:false,provider_execution:'not_run'};
}
export function renderResearchSetupPlan(plan) {
 return ['Flow research setup - preview',`Project: ${plan.repository}`,`Official CLI: ${plan.codex_executable.path}`,`Expected version (not observed): ${plan.codex_executable.expected_version}`,`Executable: ${plan.codex_executable.sha256}`,`Selection: ${plan.codex_executable.provenance.kind}`,`Authority: ${plan.setup.authority_directory}`,`Existing client: ${plan.selected_client??'new research-only client'}`,`Preserved checker: ${plan.retained_check_digest??'none; no project check required'}`,`Trust: ${plan.trust_disclosure}`,'No feature brief, project command, owner or provider is needed for setup. Setup never launches research.',''].map(terminalText).join('\n');
}
export async function applyResearchSetupPlan(plan,options,{env,cwd}) {
 const current=createResearchSetupPlan(options,{env,cwd});
 if(digest(current)!==digest(plan)) fail('Research setup inputs changed after preview. Preview again; no replacement was selected.');
 const executable=executableIdentity(plan.codex_executable.path,codexExecutionAdapter,env,'supervised-native-cli');
 const result=await provisionLocalClient({repository:plan.repository,executable,gitIdentity:plan.git_identity,check:plan.retained_check??undefined,runtimeRoot:plan.runtime_root,node:plan.node,env,
  upgradeRuntime:plan.setup.upgrade_runtime,preserveSelectedCheck:Boolean(plan.selected_client)});
 return {status:'setup_only',directory:result.directory,client:join(result.directory,'flow'),profile_reused:result.reused,runtime_upgrade:result.runtimeChanged,purpose:'research',owner_started:false,provider_execution:'not_run',
  next_commands:[`flow-supervised research --repository '${plan.repository.replaceAll("'","'\\''")}' --client '${result.directory.replaceAll("'","'\\''")}' --question 'Your question' --source 'Your source file'`],instruction:'Select plain question and source files, inspect the exact research preview, then confirm launch separately.'};
}
