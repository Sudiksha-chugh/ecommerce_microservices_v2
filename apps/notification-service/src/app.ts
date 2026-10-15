import express from 'express';
import {z} from 'zod';
import type {Identity,TokenVerifier} from '@ecommerce/security';
import {NotificationOperationError,NotificationRepository,notificationSummary} from './repository.js';
import {notificationTransitions} from './domain/state-machine.js';
const uuid=z.uuid();
const query=z.strictObject({limit:z.coerce.number().int().min(1).max(100).default(20),offset:z.coerce.number().int().min(0).max(10000).default(0),status:z.enum(Object.keys(notificationTransitions) as [string,...string[]]).optional(),type:z.enum(['ORDER_CONFIRMED','ORDER_CANCELLED','PAYMENT_SUCCEEDED','PAYMENT_FAILED','REFUND_SUCCEEDED','REFUND_FAILED','REFUND_PENDING']).optional()});
export function createNotificationApp(repository:NotificationRepository,verify:TokenVerifier,readiness:()=>string=()=> 'disabled',lookupSupported=true){
 const app=express();app.disable('x-powered-by');app.get('/health',(_req,res)=>res.json({status:'ok',service:'notification-service'}));
 app.use('/internal/notifications',async(req,res,next)=>{res.set('Cache-Control','no-store');try{res.locals.identity=await verify(req.headers.authorization);}catch{res.set('WWW-Authenticate','Bearer').status(401).json({error:{message:'Unauthorized'}});return;}if((res.locals.identity as Identity).role!=='admin'){res.status(403).json({error:{message:'Forbidden'}});return;}next();});
 app.get('/internal/notifications/health',(_req,res)=>res.json({status:'ok'}));
 app.get('/internal/notifications/readiness',async(_req,res)=>{try{await repository.pool.query('SELECT 1');const messaging=readiness();res.status(['ready','disabled'].includes(messaging)?200:503).json({database:'ready',messaging});}catch{res.status(503).json({database:'unavailable'});}});
 app.get('/internal/notifications/metrics',async(_req,res)=>res.json(await repository.metrics()));
 app.get('/internal/notifications',async(req,res)=>{const parsed=query.safeParse(req.query);if(!parsed.success){res.status(400).json({error:{message:'Invalid notification filters'}});return;}const p=parsed.data;res.json({notifications:(await repository.list(p.limit,p.offset,p.status,p.type)).map(notificationSummary),limit:p.limit,offset:p.offset});});
 app.get('/internal/notifications/:id/attempts',async(req,res)=>{const id=uuid.safeParse(req.params.id);if(!id.success){res.status(400).json({error:{message:'Invalid notification ID'}});return;}res.json({attempts:await repository.attempts(id.data)});});
 app.get('/internal/notifications/:id',async(req,res)=>{const id=uuid.safeParse(req.params.id);if(!id.success){res.status(400).json({error:{message:'Invalid notification ID'}});return;}res.json(notificationSummary(await repository.get(id.data)));});
 app.post('/internal/notifications/:id/retry',express.json(),async(req,res)=>{const id=uuid.safeParse(req.params.id),unparsed=req.body===undefined&&(Number(req.headers['content-length']??0)>0||req.headers['transfer-encoding']!==undefined);if(!id.success||unparsed||!z.strictObject({}).default({}).safeParse(req.body).success){res.status(400).json({error:{message:'Invalid retry request'}});return;}res.status(202).json(await repository.retry(id.data,(res.locals.identity as Identity).id,lookupSupported));});
 app.use((_req,res)=>res.status(404).json({error:{message:'Route not found'}}));
 app.use(((error:unknown,_req,res,_next)=>{if(error instanceof NotificationOperationError){res.status(error.status).json({error:{message:error.message}});return;}if(typeof error==='object'&&error&&'type' in error&&error.type==='entity.parse.failed'){res.status(400).json({error:{message:'Invalid JSON'}});return;}console.error(JSON.stringify({component:'notification-api',outcome:'request_failed'}));res.status(500).json({error:{message:'Notification operation unavailable'}});}) as express.ErrorRequestHandler);return app;
}
