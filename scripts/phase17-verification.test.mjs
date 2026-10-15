import {it,expect,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {phase17PathAllowed,verifyPhase17Source} from './phase17-source.mjs';
import {waitForBackend,ownedContainerState} from './observability-readiness.mjs';
it('includes preload declarations and proof discovery while excluding actual environment and secrets',()=>{
 for(const p of ['packages/observability/bootstrap.d.mts','packages/observability/config.d.mts','vitest.observability.config.mjs','docs/phase-17-stabilization-report.md'])expect(phase17PathAllowed(p)).toBe(true);
 for(const p of ['.env','.env.auth','docs/.env.private.json','.secrets/password','private-keys/a.ts','../apps/a.ts','node_modules/a.ts'])expect(phase17PathAllowed(p)).toBe(false);
});
it('rejects source changes, missing declarations and added files against an approved identity',async()=>{
 const root=await mkdtemp(join(tmpdir(),'phase17-source-test-'));try{await mkdir(join(root,'packages/observability'),{recursive:true});const path='packages/observability/bootstrap.d.mts';await writeFile(join(root,path),'declaration');const files=[{path,sha256:createHash('sha256').update('declaration').digest('hex')}],identity=createHash('sha256').update(JSON.stringify(files)).digest('hex');await writeFile(join(root,'phase17-source-manifest.json'),JSON.stringify({identity,files}));await expect(verifyPhase17Source(root,identity)).resolves.toMatchObject({identity});await writeFile(join(root,path),'changed');await expect(verifyPhase17Source(root,identity)).rejects.toThrow('source changed');await writeFile(join(root,path),'declaration');await writeFile(join(root,'vitest.observability.config.mjs'),'extra');await expect(verifyPhase17Source(root,identity)).rejects.toThrow('Unexpected');await expect(verifyPhase17Source(root,'0'.repeat(64))).rejects.toThrow('identity');}finally{await rm(root,{recursive:true,force:true});}
});
it('records the exact failed readiness operation and retains the original exception',async()=>{
 const report={checks:[]},error=new Error('fetch failed',{cause:{code:'UND_ERR_SOCKET'}});await expect(waitForBackend('tempo-ready',async()=>{throw error;},report,{budgetMs:0})).rejects.toBe(error);expect(report.failedOperation).toMatchObject({name:'tempo-ready',attempts:1,error:'fetch failed',cause:'UND_ERR_SOCKET'});expect(report.checks).toEqual([]);
});
it('records successful readiness and stops on interruption',async()=>{
 const report={checks:[]},check=vi.fn().mockResolvedValue({ok:true});await expect(waitForBackend('grafana-health',check,report)).resolves.toEqual({ok:true});expect(report.checks[0]).toMatchObject({name:'grafana-health',passed:true,attempts:1});await expect(waitForBackend('prometheus-config',check,report,{interrupted:()=>true})).rejects.toThrow('interrupted');expect(check).toHaveBeenCalledOnce();
});
it('retains safe state and resource limits only for the owned telemetry project',()=>{
 const project='commerce-v2-observability-012345abcdef',row={Id:'id',Name:'name',Config:{Env:['SECRET'],Labels:{'com.docker.compose.project':project,'com.docker.compose.service':'tempo'}},State:{Status:'running',Running:true,OOMKilled:false,ExitCode:0},HostConfig:{Memory:512,NanoCpus:1},RestartCount:0};expect(ownedContainerState([row],project)[0]).toMatchObject({service:'tempo',health:'not configured',oomKilled:false,memoryLimitBytes:512});expect(JSON.stringify(ownedContainerState([row],project))).not.toContain('SECRET');expect(()=>ownedContainerState([row],'commerce-v2-observability-ffffffffffff')).toThrow('Foreign');
});
