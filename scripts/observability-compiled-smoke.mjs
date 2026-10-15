import {mkdtemp,readdir,readFile,writeFile,copyFile,symlink,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import ts from 'typescript';
const directory=await mkdtemp(join(tmpdir(),'commerce-v2-observability-compiled-'));
try{
 await mkdir(join(directory,'src'));await writeFile(join(directory,'package.json'),'{"type":"module"}');await symlink(resolve('node_modules'),join(directory,'node_modules'),'dir');
 for(const file of await readdir('packages/observability/src'))if(file.endsWith('.ts')){const source=await readFile('packages/observability/src/'+file,'utf8');const output=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.ESNext}});await writeFile(join(directory,'src',file.replace(/\.ts$/,'.js')),output.outputText);}
 for(const file of ['bootstrap.mjs','config.mjs'])await copyFile('packages/observability/'+file,join(directory,file));
 await writeFile(join(directory,'entry.mjs'),`import assert from 'node:assert/strict';
 const initialized=globalThis[Symbol.for('ecommerce.observability')];assert.equal(initialized.enabled,true);assert.equal(initialized.serviceName,'compiled-proof');
 // These library imports happen after the --import preload completed.
 const [{default:express},{operation,correlation}]=await Promise.all([import('express'),import('./src/index.js')]);assert.equal(typeof express,'function');
 await operation('compiled-proof',{},async()=>{assert.match(correlation().traceId,/^[0-9a-f]{32}$/);});await initialized.shutdown();console.log(JSON.stringify({compiled:true,preloaded:true,passed:true}));`);
 const result=await promisify(execFile)(process.execPath,['--import',join(directory,'bootstrap.mjs'),join(directory,'entry.mjs')],{env:{...process.env,OTEL_ENABLED:'true',OTEL_SERVICE_NAME:'compiled-proof',OTEL_EXPORTER_OTLP_ENDPOINT:'http://127.0.0.1:1',OTEL_TRACES_SAMPLER_ARG:'1',OTEL_EXPORTER_OTLP_TIMEOUT:'50',OTEL_SHUTDOWN_TIMEOUT_MS:'100'},timeout:5000});process.stdout.write(result.stdout);
}finally{await rm(directory,{recursive:true,force:true});}
