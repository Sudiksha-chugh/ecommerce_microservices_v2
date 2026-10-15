import {it,expect} from 'vitest';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {phase18PathAllowed,preparePhase18Source,verifyPhase18Source} from './phase18-source.mjs';
it('excludes data/credentials and pins SQL source, dashboard and integration discovery',async()=>{
 for(const path of ['.env','data/db.sql','.secrets/password','private-keys/key.json','../outside.ts','/tmp/unsafe.ts'])expect(phase18PathAllowed(path)).toBe(false);
 const root=await mkdtemp(join(tmpdir(),'phase18-manifest-test-'));
 try{await promisify(execFile)('git',['init','-q'],{cwd:root});for(const [name,value] of [['packages/observability/src/sql-plan.ts','export const version=1;'],['infrastructure/observability/grafana/dashboards/sql-performance.json','{}'],['vitest.sql-integration.config.mjs','export default {};'],['phase17-source-manifest.json','{}'],['.env','password=private']]){const path=join(root,name);await mkdir(join(path,'..'),{recursive:true});await writeFile(path,value);}
 const destination=join(root,'snapshot'),manifest=await preparePhase18Source(root,destination);expect(manifest.files).toHaveLength(4);expect(manifest.files.some(file=>file.path==='.env')).toBe(false);await verifyPhase18Source(destination,manifest.identity);await writeFile(join(destination,'packages/observability/src/sql-plan.ts'),'tampered');await expect(verifyPhase18Source(destination,manifest.identity)).rejects.toThrow('source changed');
 }finally{await rm(root,{recursive:true,force:true});}
});
