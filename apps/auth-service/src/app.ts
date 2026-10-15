import {httpTelemetry,mountSqlReporting} from '@ecommerce/observability';
import {verifyInternalRequest} from '@ecommerce/security';
import {z} from 'zod';
import type {PublicUser} from '@ecommerce/contracts';
import express from 'express';
import type { AuthService } from './auth-service.js';
import { loginSchema, registrationSchema } from './user-validation.js';
import { errorHandler } from './middleware/error-handler.js';

export function createApp(auth: AuthService,internal?:{key:string;lookup:(id:string)=>Promise<PublicUser|undefined>},sqlVerify?:(authorization:string|undefined)=>Promise<{role:string}>) {
  const app = express();app.use(httpTelemetry('auth-service'));
  app.disable('x-powered-by');if(sqlVerify)mountSqlReporting(app,sqlVerify);
  app.get('/internal/users/:id/contact',async(req,res)=>{
    res.set('Cache-Control','no-store');
    if(!internal||!verifyInternalRequest(req.headers,req.method,req.path,internal.key)){res.status(401).json({error:{message:'Unauthorized'}});return;}
    const id=z.uuid().safeParse(req.params.id);if(!id.success){res.status(400).json({error:{message:'Invalid user ID'}});return;}
    const user=await internal.lookup(id.data);if(!user){res.status(404).json({error:{message:'Contact unavailable'}});return;}res.json({userId:user.id,email:user.email});
  });
  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'auth-service' }));
  // Auth responses must not be cached, especially access tokens and user identities.
  app.use('/auth', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.post('/auth/register', express.json(), async (req, res) => {
    const input = registrationSchema.safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: { message: 'Invalid registration body' } }); return; }
    res.status(201).json(await auth.register(input.data));
  });
  app.post('/auth/login', express.json(), async (req, res) => {
    const input = loginSchema.safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: { message: 'Invalid login body' } }); return; }
    res.json(await auth.login(input.data));
  });
  app.get('/auth/me', async (req, res) => {
    res.json(await auth.currentUser(req.headers.authorization));
  });
  app.use((_req, res) => res.status(404).json({ error: { message: 'Route not found' } }));
  app.use(errorHandler);
  return app;
}
