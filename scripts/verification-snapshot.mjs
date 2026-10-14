// Creates a local source-only snapshot. Never uploads or reads development env files.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,lstat,copyFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const execute=promisify(execFile);
export function validateCommitIdentity(actual,expected,workflow){
 if(!/^[a-f0-9]{40}$/.test(expected??'')||actual!==expected||(workflow&&workflow!==expected))throw new Error('Expected Git commit is missing or mismatched');
}
export async function sourceRevision(root,{expectedCommit,workflowCommit,branch}={}){
 let commit;
 try{commit=(await execute('git',['rev-parse','HEAD'],{cwd:root,timeout:5000})).stdout.trim();}catch(error){if(expectedCommit!==undefined)throw error;}
 if(expectedCommit!==undefined)validateCommitIdentity(commit,expectedCommit,workflowCommit);
 const result={commit:commit??'not available (archive)',branch:branch??'local preparation'};
 for(const [key,path] of [['lockfileSha256','package-lock.json'],['workflowSha256','.github/workflows/phase16-verification.yml'],['verificationScriptSha256','scripts/verify-phase16.mjs']])result[key]=createHash('sha256').update(await readFile(join(root,path))).digest('hex');
 return result;
}
export function snapshotPathAllowed(path){
 if(path.split('/').some(part=>/^\.?(?:secrets?|credentials?|private[-_]?keys?)(?:\.|$)/i.test(part)))return false;
 if(path.split('/').some(part=>['.git','node_modules','data','dumps','coverage','verification-evidence'].includes(part)))return false;
 if(path.split('/').some(part=>part.startsWith('.env')&&!part.endsWith('.example')))return false;
 return ['package.json','package-lock.json','tsconfig.json','tsconfig.base.json','vitest.config.ts','vitest.harness.config.mjs','.dockerignore','.gitignore'].includes(path)||/^\.env\.[\w-]+\.example$/.test(path)||path==='.env.example'||/^compose[\w.-]*\.ya?ml$/.test(path)||/^(apps|packages|scripts|test|infrastructure)\/.+\.(?:ts|mjs|json|sql|sh|py|yaml|yml|example)$/.test(path)||/^infrastructure\/docker\/[\w.-]+Dockerfile(?:\.dockerignore)?$/.test(path)||/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(path);
}
export async function verifySnapshot(root){
 const manifest=JSON.parse(await readFile(join(root,'verification-source-manifest.json'),'utf8'));
 if(createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex')!==manifest.identity)throw new Error('Snapshot manifest identity mismatch');
 for(const file of manifest.files){
  if(file.path.split('/').includes('..')||file.path.startsWith('/')||!snapshotPathAllowed(file.path))throw new Error('Unsafe snapshot path');
  if(!(await lstat(join(root,file.path))).isFile())throw new Error('Snapshot source is not a regular file');
  if(createHash('sha256').update(await readFile(join(root,file.path))).digest('hex')!==file.sha256)throw new Error('Snapshot file mismatch: '+file.path);
 }
 const expected=new Set(manifest.files.map(file=>file.path));
 async function check(directory,prefix=''){
  for(const entry of await readdir(directory,{withFileTypes:true})){
   if(['node_modules','.git','verification-evidence'].includes(entry.name))continue;
   const path=prefix+entry.name;
   if(entry.isDirectory())await check(join(directory,entry.name),path+'/');
   else if(snapshotPathAllowed(path)&&!expected.has(path))throw new Error('Unexpected snapshot source: '+path);
  }
 }
 await check(root);
 return manifest.identity;
}
export async function sourceManifest(root){
 const paths=(await execute('git',['ls-files','-z','--cached','--others','--exclude-standard'],{cwd:root,maxBuffer:10000000})).stdout.split('\0').filter(Boolean).filter(snapshotPathAllowed).sort();
 const files=[];
 for(const path of [...new Set(paths)]){
  const source=join(root,path);if(!(await lstat(source)).isFile())throw new Error('Snapshot requires regular source file: '+path);
  files.push({path,sha256:createHash('sha256').update(await readFile(source)).digest('hex')});
 }
 return {identity:createHash('sha256').update(JSON.stringify(files)).digest('hex'),files};
}
export async function snapshot(root,output){
 const {identity,files:manifest}=await sourceManifest(root);
 const stage=await mkdtemp(join(tmpdir(),'commerce-v2-source-snapshot-'));
 try{
  for(const {path,sha256} of manifest){
   const source=join(root,path);const destination=join(stage,'source',path);await mkdir(dirname(destination),{recursive:true});await copyFile(source,destination);
   if(createHash('sha256').update(await readFile(destination)).digest('hex')!==sha256)throw new Error('Source changed during snapshot: '+path);
  }
  await writeFile(join(stage,'source','verification-source-manifest.json'),JSON.stringify({identity,files:manifest},null,2)+'\n',{mode:0o600});
  // Exclusive output claim prevents overwriting earlier artifacts.
  await writeFile(output,'',{flag:'wx',mode:0o600});
  await execute('tar',['-czf',output,'-C',join(stage,'source'),'.'],{timeout:30000,env:{...process.env,COPYFILE_DISABLE:'1'}});
  return {identity,files:manifest.length,archive:output};
 }finally{await rm(stage,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
 if(process.argv[2]==='--manifest'&&process.argv.length===3){
  const manifest=await sourceManifest(root);await writeFile(join(root,'verification-source-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({identity:manifest.identity,files:manifest.files.length}));
 }else{
  if(process.argv.length!==3)throw new Error('Usage: node scripts/verification-snapshot.mjs [--manifest | /absolute/local/source.tar.gz]');
  console.log(JSON.stringify(await snapshot(root,resolve(process.argv[2]))));
 }
}
