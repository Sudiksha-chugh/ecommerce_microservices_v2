import express from 'express';
import {z} from 'zod';
import {SqlAdvisor,advisorCandidates,approvedPlanSnapshot,recommendationSchema} from './sql-advisor.js';
import type {SqlDiagnostics} from './sql-diagnostics.js';
const requestSchema=z.union([z.object({fingerprint:z.string().regex(/^q_[a-f0-9]{24}$/)}).strict(),z.object({queryId:z.string().min(1).max(64)}).strict()]);
export function sqlAdvisorReporting(verify:(authorization:string|undefined)=>Promise<{role:string}>,advisor:SqlAdvisor,diagnostics?:SqlDiagnostics){
 const router=express.Router();let admitted:number[]=[];let active=0;
 router.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
 router.use(async(req,res,next)=>{try{const identity=await verify(req.headers.authorization);if(identity.role!=='admin'){res.status(403).json({error:'forbidden'});return;}}catch{res.status(401).set('WWW-Authenticate','Bearer').json({error:'unauthorized'});return;}next();});
 router.use((req,res,next)=>{if(Object.keys(req.query).length){res.status(400).json({error:'invalid_request'});return;}const now=Date.now();admitted=admitted.filter(t=>t>now-60000);if(admitted.length>=20||active>=2){res.status(429).json({error:'busy'});return;}admitted.push(now);active++;res.once('close',()=>{active--;});next();});
 router.get('/health',(_req,res)=>res.json(advisor.health()));
 router.get('/candidates',(_req,res)=>res.json({candidates:advisorCandidates().map(s=>({fingerprint:s.fingerprint,operation:s.operation,sampledCount:s.sampledCount,p95UpperMs:s.p95UpperMs})),approvedQueries:diagnostics?.queries()??[]}));
 router.post('/analyze',express.json({limit:'1kb',strict:true}),async(req,res)=>{
  const parsed=requestSchema.safeParse(req.body);if(!parsed.success){res.status(400).json({error:'invalid_request'});return;}
  try{const id=parsed.data;const snapshot='fingerprint' in id?advisorCandidates().find(s=>s.fingerprint===id.fingerprint):diagnostics&&diagnostics.queries().includes(id.queryId)?await approvedPlanSnapshot(diagnostics,id.queryId):undefined;
   if(!snapshot){res.status(404).json({error:'unknown_snapshot'});return;}
   const result=await advisor.analyze(snapshot);recommendationSchema.parse(result.recommendation);res.json(result);
  }catch{res.status(503).json({error:'diagnostics_unavailable'});}
 });
 router.use((_error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{res.status(400).json({error:'invalid_request'});});return router;
}
