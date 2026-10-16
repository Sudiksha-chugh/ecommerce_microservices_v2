import {incidentReporting} from './incident/api.js';
import {configuredIncidentAnalysis} from './incident/server.js';
import {readFile} from 'node:fs/promises';
import express from 'express';
import {Pool} from 'pg';
import {createTokenVerifier} from '@ecommerce/security';
import {sqlReporting} from './sql-reporting.js';
import {SqlDiagnostics} from './sql-diagnostics.js';
import {SqlAdvisor,advisorConfig} from './sql-advisor.js';
import {configuredAdvisorProvider} from './sql-advisor-provider.js';
import {sqlAdvisorReporting} from './sql-advisor-reporting.js';
// A separate, explicitly started internal process. No application-pool reuse or auto-provisioning.
export async function startSqlDiagnostics(env:NodeJS.ProcessEnv=process.env){
 if(env.SQL_DIAGNOSTICS_ENABLED!=='true')return;
 const required=(name:string)=>{const value=env[name];if(!value)throw new Error('Missing diagnostic configuration');return value;};
 const service=required('SQL_DIAGNOSTIC_SERVICE');if(!['catalog','auth','orders','inventory','payments','notifications','search'].includes(service))throw new Error('Invalid diagnostic service');
 const port=Number(env.SQL_DIAGNOSTIC_PORT??'3218');if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid diagnostic port');
 const role=required('SQL_DIAGNOSTIC_PGUSER');if(!/^sql_diag_[a-z_]{1,40}$/.test(role))throw new Error('Invalid diagnostic role');
 const password=(await readFile(required('SQL_DIAGNOSTIC_PASSWORD_FILE'),'utf8')).trim();if(!password||password.length>1024)throw new Error('Invalid diagnostic credential file');
 const verify=await createTokenVerifier(await readFile(required('JWT_PUBLIC_KEY_FILE'),'utf8'),{issuer:required('JWT_ISSUER'),audience:required('JWT_AUDIENCE')});
 const pgPort=Number(env.SQL_DIAGNOSTIC_PGPORT??5432);if(!Number.isInteger(pgPort)||pgPort<1||pgPort>65535)throw new Error('Invalid diagnostic database port');
 const host=required('SQL_DIAGNOSTIC_PGHOST');if(!['127.0.0.1','::1','localhost'].includes(host))throw new Error('Diagnostics require an authenticated local database tunnel');
 const pool=new Pool({host,port:pgPort,database:required('SQL_DIAGNOSTIC_PGDATABASE'),user:role,password,max:1,connectionTimeoutMillis:1000,statement_timeout:1000,query_timeout:1500,idleTimeoutMillis:1000,maxLifetimeSeconds:60,application_name:'sql-diagnostics'});
 pool.on('error',()=>{});
 const diagnostics=new SqlDiagnostics(pool,service);
 const config=advisorConfig(env),advisor=new SqlAdvisor(config,configuredAdvisorProvider(config,env));
 const app=express();if(env.INCIDENT_DIAGNOSTICS_ENABLED==='true')app.use('/internal/incidents',incidentReporting(verify,configuredIncidentAnalysis(env)));app.use('/internal/sql-advisor',sqlAdvisorReporting(verify,advisor,diagnostics));app.disable('x-powered-by');app.use('/internal/sql',sqlReporting(verify,diagnostics));app.use((_req,res)=>res.status(404).json({error:'not_found'}));
 const server=app.listen(port,'127.0.0.1');server.maxConnections=8;server.requestTimeout=5000;server.headersTimeout=5000;server.keepAliveTimeout=1000;
 await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);}).catch(async()=>{await pool.end();throw new Error('Diagnostic listener unavailable');});
 return {port,close:async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end();}};
}
