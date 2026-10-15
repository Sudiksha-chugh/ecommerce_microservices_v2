// Retain bounded, sanitized assertion evidence; never upload raw Vitest reports or request payloads.
import {readFile} from 'node:fs/promises';
import {redactEvidence} from './verification-harness.mjs';
const safe=value=>redactEvidence(String(value??'')).replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,'<redacted-jwt>');
export function summarizeTests(raw){
 const summary={counts:{},failures:[],unexecuted:[],suiteErrors:[],truncated:false};let remaining=262144;
 const bounded=value=>{const text=safe(value),limit=Math.min(8192,Math.max(0,remaining));remaining-=Math.min(text.length,limit);if(text.length>limit){summary.truncated=true;return text.slice(0,limit)+' [truncated]';}return text;};
 for(const key of ['numTotalTests','numPassedTests','numFailedTests','numPendingTests','numTodoTests','numFailedTestSuites'])summary.counts[key]=raw[key];summary.success=raw.success;
 for(const suite of raw.testResults??[]){const file=bounded(suite.name);if(suite.message)summary.suiteErrors.push({file,status:suite.status,message:bounded(suite.message)});
  for(const test of suite.assertionResults??[]){if(test.status==='passed')continue;const record={file,name:bounded(test.fullName??test.title),status:test.status};if(test.status==='failed'){record.errors=(test.failureMessages??[]).map(bounded);summary.failures.push(record);}else summary.unexecuted.push(record);}
 }
 return summary;
}
export async function readTestEvidence(path){return summarizeTests(JSON.parse(await readFile(path,'utf8')));}
