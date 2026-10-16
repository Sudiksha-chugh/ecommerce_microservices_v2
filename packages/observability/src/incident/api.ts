import express from 'express';
import { requestSchema } from './schemas.js';
import { IncidentAnalysis, InvestigationBusy, InvalidInvestigation } from './engine.js';
export type IncidentVerifier = (authorization: string | undefined) => Promise<{
    role: string;
}>;
// Host only on the internal loopback diagnostics listener. Never mount on the public gateway.
export function incidentReporting(verify: IncidentVerifier, analysis: IncidentAnalysis, now = Date.now) {
    const router = express.Router();
    let admissions: number[] = [];
    let active = 0;
    router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    router.use(async (req, res, next) => { try {
        const identity = await verify(req.headers.authorization);
        if (identity.role !== 'admin') {
            res.status(403).json({ error: 'forbidden' });
            return;
        }
    }
    catch {
        res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'unauthorized' });
        return;
    } next(); });
    router.use((req, res, next) => { if (Object.keys(req.query).length) {
        res.status(400).json({ error: 'invalid_request' });
        return;
    } const time = now(); admissions = admissions.filter(t => t > time - 60000); if (admissions.length >= analysis.limits.requestsPerMinute || active >= analysis.limits.concurrent) {
        res.status(429).json({ error: 'busy' });
        return;
    } admissions.push(time); active++; res.once('close', () => active--); next(); });
    router.get('/health', (_req, res) => res.json(analysis.health()));
    router.get('/capabilities', (_req, res) => res.json(analysis.capabilities()));
    router.post('/analyze', express.json({ limit: '2kb', strict: true }), async (req, res) => { const parsed = requestSchema.safeParse(req.body); if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request' });
        return;
    } try {
        res.json(await analysis.analyze(parsed.data));
    }
    catch (error) {
        res.status(error instanceof InvestigationBusy ? 429 : error instanceof InvalidInvestigation ? 400 : 503).json({ error: error instanceof InvestigationBusy ? 'busy' : error instanceof InvalidInvestigation ? 'invalid_investigation' : 'diagnostics_unavailable' });
    } });
    router.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(400).json({ error: 'invalid_request' }));
    return router;
}
