import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {it,expect} from 'vitest';
const execute=promisify(execFile);
it.each(['disabled','invalid','unavailable','timeout','queue','shutdown'])('isolates %s telemetry in a fresh Node process',async mode=>{
 const result=await execute(process.execPath,[new URL('./runtime-fixture.mjs',import.meta.url).pathname,mode],{env:{...process.env,OTEL_ENABLED:'false'},timeout:5000});
 expect(JSON.parse(result.stdout.trim())).toMatchObject({mode,passed:true});
});
