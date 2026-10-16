import {z} from 'zod';
import {AdvisorProviderError,advisorConfig,type AdvisorConfig} from './sql-advisor.js';
import {operation} from './context.js';
export interface NarrativeReport {summary:string;analysisMode:'deterministic'|'ai_enriched';aiStatus:'disabled'|'success'|'timeout'|'unavailable'|'invalid_response'|'budget'|'circuit_open';}
export interface NarrativeProvider<T> {readonly identity:string;enrich(report:T,signal:AbortSignal):Promise<unknown>;}
export class NarrativeAi<T extends NarrativeReport> {
    private admissions: number[] = [];
    private active = 0;
    private failures = 0;
    private openUntil = 0;
    constructor(private config: AdvisorConfig, private provider?: NarrativeProvider<T>, private now = Date.now, private spanName:'incident.ai_enrich'|'performance.ai_enrich'='incident.ai_enrich', private choices:(report:T)=>string[]=(r)=>[r.summary, 'Review the ranked hypotheses and validate each against the linked evidence before considering an operational change']) {
        const mapped: NodeJS.ProcessEnv = {};
        for (const [key, value] of Object.entries(config)) {
            if (key === 'enabled') continue;
            mapped['SQL_ADVISOR_' + key.replace(/[A-Z]/g, c => '_' + c.toLowerCase()).toUpperCase()] = String(value);
        }
        advisorConfig(mapped);
        this.config = Object.freeze({...config});
        if (config.enabled && !provider)
        throw new Error('Explicit narrative provider required'); }
    identity() { return this.config.enabled ? this.provider!.identity : 'disabled'; }
    async enrich(report: T, outer: AbortSignal): Promise<T> {
        if (!this.config.enabled)
            return report;
        if (outer.aborted)
            return { ...report, aiStatus: 'timeout' };
        const now = this.now();
        this.admissions = this.admissions.filter(t => t > now - 60000);
        const failed = (aiStatus: T['aiStatus']): T => ({ ...report, aiStatus });
        if (now < this.openUntil)
            return failed('circuit_open');
        if (this.active >= this.config.maxConcurrent || this.admissions.length >= this.config.requestsPerMinute || (this.admissions.length + 1) * (this.config.maxOutputTokens + 32768) > this.config.tokensPerMinute)
            return failed('budget');
        this.admissions.push(now);
        this.active++;
        const controller = new AbortController();
        const signal = AbortSignal.any([outer, controller.signal]);
        let timer: ReturnType<typeof setTimeout> | undefined;
        let abortHandler: (() => void) | undefined;
        return operation(this.spanName, {}, async () => {
            try {
                const result = await Promise.race([Promise.resolve().then(() => { return this.provider!.enrich(structuredClone(report), signal); }).finally(() => this.active--), new Promise<never>((_, reject) => { abortHandler = () => reject(new AdvisorProviderError('timeout')); signal.addEventListener('abort', abortHandler, { once: true }); if (signal.aborted)
                        abortHandler(); timer = setTimeout(() => controller.abort(), this.config.timeoutMs); })]);
                if (JSON.stringify(result)?.length > 4096)
                    throw new AdvisorProviderError('invalid_response');
                const parsed = z.object({ summary: z.string().max(500) }).strict().safeParse(result);
                if (!parsed.success || !this.choices(report).includes(parsed.data.summary))
                    throw new AdvisorProviderError('invalid_response');
                this.failures = 0;
                return { ...report, summary: parsed.data.summary, analysisMode: 'ai_enriched', aiStatus: 'success' };
            }
            catch (error) {
                if (++this.failures >= 3)
                    this.openUntil = this.now() + 30000;
                return failed(error instanceof AdvisorProviderError && ['timeout', 'invalid_response', 'budget'].includes(error.code) ? error.code as T['aiStatus'] : 'unavailable');
            }
            finally {
                clearTimeout(timer);
                if (abortHandler)
                    signal.removeEventListener('abort', abortHandler);
                controller.abort();
            }
        });
    }
}
