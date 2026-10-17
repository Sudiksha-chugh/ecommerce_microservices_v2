import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {it,expect} from 'vitest';
const execute=promisify(execFile),cwd=fileURLToPath(new URL('../../',import.meta.url));
it.each(['resilience-worker.mjs','resilience-crash-child.mjs'])('%s cannot be enabled by normal production environment configuration',async script=>{
 try{await execute(process.execPath,['--import','tsx',`scripts/${script}`],{cwd,env:{PATH:process.env.PATH,NODE_ENV:'production',PHASE22_PROJECT:'phase22-'+'a'.repeat(24),PHASE22_PGPORT:'1',PHASE22_MODE:'payment'},timeout:5000,maxBuffer:10000});throw new Error('Test hook unexpectedly activated');}
 catch(error){const result=error as {code?:number;stderr?:string};expect(result.code).toBe(1);expect(result.stderr).toMatch(/Owned IPC (?:worker|child) required/);expect(result.stderr).not.toContain('ECONNREFUSED');}
});
