import { readFile } from 'node:fs/promises';
import express from 'express';
import { createTokenVerifier } from '@ecommerce/security';
import { incidentReporting, type IncidentVerifier } from './api.js';
import { IncidentAnalysis } from './engine.js';
import { defaultCollectors } from './collectors.js';
import { defaultLimits, limitsSchema } from './schemas.js';
import { configuredIncidentAi } from './ai.js';
export function configuredIncidentAnalysis(env: NodeJS.ProcessEnv = process.env) { const limits = { ...defaultLimits }; for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
    const name = 'INCIDENT_LIMIT_' + key.replace(/[A-Z]/g, c => '_' + c.toLowerCase()).toUpperCase();
    if (env[name] !== undefined)
        limits[key] = Number(env[name]);
} limitsSchema.parse(limits); return new IncidentAnalysis(defaultCollectors({ ...(env.INCIDENT_PROMETHEUS_ORIGIN ? { prometheus: env.INCIDENT_PROMETHEUS_ORIGIN } : {}), ...(env.INCIDENT_TEMPO_ORIGIN ? { tempo: env.INCIDENT_TEMPO_ORIGIN } : {}) }, limits), limits, configuredIncidentAi(env)); }
export function incidentApp(verify: IncidentVerifier, analysis: IncidentAnalysis) { const app = express(); app.disable('x-powered-by'); app.use('/internal/incidents', incidentReporting(verify, analysis)); app.use((_req, res) => res.status(404).json({ error: 'not_found' })); return app; }
// Same explicit internal diagnostics deployment pattern as Phase 19, without any database pool.
export async function startIncidentDiagnostics(env: NodeJS.ProcessEnv = process.env) { if (env.INCIDENT_DIAGNOSTICS_ENABLED !== 'true')
    return; const required = (key: string) => { const v = env[key]; if (!v)
    throw new Error('Missing incident diagnostic configuration'); return v; }; const port = Number(env.INCIDENT_DIAGNOSTIC_PORT ?? 3219); if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('Invalid incident diagnostic port'); const verify = await createTokenVerifier(await readFile(required('JWT_PUBLIC_KEY_FILE'), 'utf8'), { issuer: required('JWT_ISSUER'), audience: required('JWT_AUDIENCE') }); const server = incidentApp(verify, configuredIncidentAnalysis(env)).listen(port, '127.0.0.1'); server.maxConnections = 8; server.requestTimeout = 12000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000; await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); }); return { port, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } }; }
