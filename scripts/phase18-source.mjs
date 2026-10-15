// Phase 18 source review only. Phase 16 manifest and harness remain unchanged.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {readFile,writeFile,lstat,mkdir,copyFile,readdir} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {snapshotPathAllowed} from './verification-snapshot.mjs';
const execute=promisify(execFile),hash=data=>createHash('sha256').update(data).digest('hex');
export function phase18PathAllowed(path){
 if(path.startsWith('/')||path.split('/').some(p=>['..','.git','node_modules','data','dumps','coverage','verification-evidence'].includes(p)||(p.startsWith('.env')&&!p.endsWith('.example'))||/^\.?(?:secrets?|credentials?|private[-_]?keys?)(?:\.|$)/i.test(p)))return false;
 return snapshotPathAllowed(path)||path==='vitest.observability.config.mjs'||path==='vitest.sql-integration.config.mjs'||path==='phase17-source-manifest.json'||path==='README.md'||path==='verification-source-manifest.json'||/^packages\/observability\/.+\.d\.mts$/.test(path)||/^docs\/.+\.(?:md|json)$/.test(path);
}
export async function phase18Manifest(root){
 const paths=[...new Set((await execute('git',['ls-files','-z','--cached','--others','--exclude-standard'],{cwd:root,maxBuffer:10000000})).stdout.split('\0').filter(phase18PathAllowed))].sort();
 const files=[];for(const path of paths){const source=join(root,path);if(!(await lstat(source)).isFile())throw new Error('Source must be a regular file: '+path);files.push({path,sha256:hash(await readFile(source))});}
 return {identity:hash(JSON.stringify(files)),files};
}
export async function verifyPhase18Source(root,identity){
 const manifest=JSON.parse(await readFile(join(root,'phase18-source-manifest.json'),'utf8'));
 if(!/^[a-f0-9]{64}$/.test(identity??'')||manifest.identity!==identity||hash(JSON.stringify(manifest.files))!==identity)throw new Error('Phase 18 source identity mismatch');
 const expected=new Set();for(const file of manifest.files){if(!phase18PathAllowed(file.path)||expected.has(file.path))throw new Error('Unsafe or duplicate Phase 18 source path');expected.add(file.path);if(!(await lstat(join(root,file.path))).isFile()||hash(await readFile(join(root,file.path)))!==file.sha256)throw new Error('Phase 18 source changed: '+file.path);}
 async function walk(directory,prefix=''){for(const entry of await readdir(directory,{withFileTypes:true})){if(['.git','node_modules','.secrets'].includes(entry.name))continue;const path=prefix+entry.name;if(entry.isDirectory())await walk(join(directory,entry.name),path+'/');else if(phase18PathAllowed(path)&&!expected.has(path))throw new Error('Unexpected Phase 18 source: '+path);}}
 await walk(root);return manifest;
}
export async function preparePhase18Source(root,destination){
 const manifest=await phase18Manifest(root);await mkdir(destination,{recursive:false,mode:0o700});
 for(const file of manifest.files){const target=join(destination,file.path);await mkdir(dirname(target),{recursive:true});await copyFile(join(root,file.path),target);}
 await writeFile(join(destination,'phase18-source-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
 await verifyPhase18Source(destination,manifest.identity);return manifest;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.length!==3)throw new Error('Usage: node scripts/phase18-source.mjs /new/local/source-directory');const manifest=await preparePhase18Source(resolve('.'),resolve(process.argv[2]));console.log(JSON.stringify({identity:manifest.identity,files:manifest.files.length,directory:resolve(process.argv[2])}));
}
