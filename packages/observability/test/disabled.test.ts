import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {it,expect} from 'vitest';
it('preserves disabled-mode dependency, request-ID, metadata and error contracts without loading exporters',async()=>{
 const result=await promisify(execFile)(process.execPath,['--import','tsx',new URL('./disabled-fixture.ts',import.meta.url).pathname],{env:{...process.env,OTEL_ENABLED:'false'},timeout:5000});
 expect(JSON.parse(result.stdout.trim())).toMatchObject({passed:true,sdkImports:0,fetchCalls:1,originalIdentities:true,originalErrors:true,headersUnchanged:true,requestIdUnchanged:true});
});
