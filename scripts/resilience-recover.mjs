// Manual recovery for interrupted live runs. Accepts a run token, never a resource ID or endpoint.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {verifyOwnership,fixtureSchema,targets} from '../packages/resilience-testing/src/index.ts';
const runId=process.argv[2];if(process.argv.length!==3||!/^[a-f0-9]{24}$/.test(runId??''))throw new Error('Usage: node --import tsx scripts/resilience-recover.mjs <24-hex-run-id>');
const execute=promisify(execFile),project=`phase22-${runId}`;
const fixture=fixtureSchema.parse({runId,project,marker:'ecommerce-phase22',resources:['postgres','rabbitmq','redis','elasticsearch']});
const docker=async args=>(await execute('docker',args,{timeout:25000,maxBuffer:200000})).stdout.trim();
const filters=['--filter',`label=com.docker.compose.project=${project}`,'--filter',`label=io.ecommerce.phase22.run=${runId}`,'--filter','label=io.ecommerce.phase22.owner=ecommerce-phase22'];
const list=s=>s?s.split('\n'):[];
const ids=list(await docker(['ps','-aq','--no-trunc',...filters]));if(ids.length>4)throw new Error('Unexpected fixture membership');
async function inspect(id){if(!/^[a-f0-9]{64}$/.test(id))throw new Error('Invalid fixture identity');const [s]=JSON.parse(await docker(['inspect',id]));const target=s.Config.Labels?.['io.ecommerce.phase22.target'];if(!targets.includes(target)||s.Config.Labels['com.docker.compose.service']!==target)throw new Error('Foreign service');verifyOwnership(fixture,{id:s.Id,kind:'container',target,labels:s.Config.Labels,mounts:s.Mounts.map(m=>m.Type)});return s;}
// Validate complete membership BEFORE the first mutation, then revalidate each mutation.
for(const id of ids)await inspect(id);
for(const id of ids){if((await inspect(id)).State.Paused)await docker(['unpause',id]);await inspect(id);await docker(['rm','--force',id]);}
for(const id of list(await docker(['network','ls','-q','--no-trunc',...filters]))){const [n]=JSON.parse(await docker(['network','inspect',id]));if(n.Labels?.['com.docker.compose.project']!==project||n.Labels['io.ecommerce.phase22.run']!==runId||n.Labels['io.ecommerce.phase22.owner']!=='ecommerce-phase22'||Object.keys(n.Containers??{}).length)throw new Error('Foreign or nonempty network');await docker(['network','rm',n.Id]);}
if(await docker(['ps','-aq',...filters])||await docker(['network','ls','-q',...filters]))throw new Error('Cleanup incomplete');
console.log(JSON.stringify({runId,cleanup:'verified'}));
