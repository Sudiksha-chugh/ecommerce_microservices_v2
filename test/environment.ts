import {join} from 'node:path';
// Alternate env files belong to a disposable integration project; production loaders are unchanged.
export function testEnvironmentFile(name:string){
 if(!/^\.env(?:\.[a-z-]+)?$/.test(name))throw new Error('Invalid test environment filename');
 return process.env.INTEGRATION_ENV_DIR?join(process.env.INTEGRATION_ENV_DIR,name):name;
}
