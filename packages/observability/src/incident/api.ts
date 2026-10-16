import {diagnosticRouter,type DiagnosticVerifier} from '../diagnostic-router.js';
import {requestSchema} from './schemas.js';
import {IncidentAnalysis,InvestigationBusy,InvalidInvestigation} from './engine.js';
export type IncidentVerifier=DiagnosticVerifier;
export function incidentReporting(verify:IncidentVerifier,analysis:IncidentAnalysis,now=Date.now){return diagnosticRouter(verify,analysis,requestSchema,error=>error instanceof InvestigationBusy?{status:429,error:'busy'}:error instanceof InvalidInvestigation?{status:400,error:'invalid_investigation'}:{status:503,error:'diagnostics_unavailable'},now);}
