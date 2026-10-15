import express from 'express';
import {SqlAdvisor,advisorConfig} from './sql-advisor.js';
import {sqlAdvisorReporting} from './sql-advisor-reporting.js';
import {sqlTelemetryConfig,sqlTelemetrySnapshot} from './sql-telemetry.js';
import {DiagnosticError,type SqlDiagnostics} from './sql-diagnostics.js';
type Verifier=(authorization:string|undefined)=>Promise<{role:string}>;
// Never mounted by default. Hosting services supply their existing cryptographic JWT verifier.
export function sqlReporting(verify:Verifier,diagnostics?:SqlDiagnostics){
 const router=express.Router();
 // Existing in-process reports can advise on their own sampled telemetry without AI or new network access.
 router.use('/advisor',sqlAdvisorReporting(verify,new SqlAdvisor(advisorConfig({}))));
 router.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
 router.use(async(req,res,next)=>{try{const identity=await verify(req.headers.authorization);if(identity.role!=='admin'){res.status(403).json({error:'forbidden'});return;}}catch{res.set('WWW-Authenticate','Bearer').status(401).json({error:'unauthorized'});return;}next();});
 router.get('/',(_req,res)=>res.json(sqlTelemetrySnapshot()));
 router.get('/queries',(_req,res)=>res.json({queries:diagnostics?.queries()??[]}));
 router.post('/explain',express.json({limit:'1kb',strict:true}),async(req,res)=>{
  if(!diagnostics){res.status(503).json({error:'diagnostics_disabled'});return;}
  if(!req.body||Object.keys(req.body).length!==1||typeof req.body.queryId!=='string'||req.body.queryId.length>64||Object.keys(req.query).length){res.status(400).json({error:'invalid_diagnostic_request'});return;}
  try{res.json(await diagnostics.explain(req.body.queryId));}catch(error){const code=error instanceof DiagnosticError?error.code:'unavailable';res.status(code==='busy'?429:code==='not_approved'?400:503).json({error:code});}
 });
 // Body parser messages may quote input. Never delegate diagnostic errors to a business logger.
 router.use((_error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{res.status(400).json({error:'invalid_diagnostic_request'});});
 return router;
}
export function mountSqlReporting(app:express.Express,verify:Verifier){if(sqlTelemetryConfig().enabled)app.use('/internal/sql',sqlReporting(verify));}
