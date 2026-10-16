import {PerformanceInvestigation} from './engine.js';
import {defaultCollectors} from './collectors.js';
import {configuredPerformanceAi} from './ai.js';
import {defaultLimits,limitsSchema} from './schemas.js';
export function configuredPerformanceAnalysis(env:NodeJS.ProcessEnv=process.env){const limits={...defaultLimits};for(const key of Object.keys(limits) as (keyof typeof limits)[]){const name='PERFORMANCE_LIMIT_'+key.replace(/[A-Z]/g,c=>'_'+c.toLowerCase()).toUpperCase();if(env[name]!==undefined)limits[key]=Number(env[name]);}limitsSchema.parse(limits);
 const prometheus=env.PERFORMANCE_PROMETHEUS_ORIGIN??env.INCIDENT_PROMETHEUS_ORIGIN,tempo=env.PERFORMANCE_TEMPO_ORIGIN??env.INCIDENT_TEMPO_ORIGIN;
 return new PerformanceInvestigation(defaultCollectors({...(prometheus?{prometheus}:{}),...(tempo?{tempo}:{})},limits),limits,configuredPerformanceAi(env));}
