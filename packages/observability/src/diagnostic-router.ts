import express from 'express';
import type {z} from 'zod';
export type DiagnosticVerifier=(authorization:string|undefined)=>Promise<{role:string}>;
interface Engine{limits:{requestsPerMinute:number;concurrent:number};health():unknown;capabilities():unknown;analyze(input:unknown):Promise<unknown>;}
// Shared authenticated, bounded, read-only diagnostics surface. Never mounted on Gateway.
export function diagnosticRouter(verify:DiagnosticVerifier,engine:Engine,schema:z.ZodType,classify:(error:unknown)=>{status:number;error:string},now=Date.now){
 const router=express.Router();let admissions:number[]=[],active=0;
 router.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
 router.use(async(req,res,next)=>{try{const identity=await verify(req.headers.authorization);if(identity.role!=='admin'){res.status(403).json({error:'forbidden'});return;}}catch{res.status(401).set('WWW-Authenticate','Bearer').json({error:'unauthorized'});return;}next();});
 router.use((req,res,next)=>{if(Object.keys(req.query).length){res.status(400).json({error:'invalid_request'});return;}const time=now();admissions=admissions.filter(t=>t>time-60000);if(admissions.length>=engine.limits.requestsPerMinute||active>=engine.limits.concurrent){res.status(429).json({error:'busy'});return;}admissions.push(time);active++;res.once('close',()=>active--);next();});
 router.get('/health',(_req,res)=>res.json(engine.health()));router.get('/capabilities',(_req,res)=>res.json(engine.capabilities()));
 router.post('/analyze',express.json({limit:'2kb',strict:true}),async(req,res)=>{const input=schema.safeParse(req.body);if(!input.success){res.status(400).json({error:'invalid_request'});return;}try{res.json(await engine.analyze(input.data));}catch(error){const safe=classify(error);res.status(safe.status).json({error:safe.error});}});
 router.use((_error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(400).json({error:'invalid_request'}));return router;
}
