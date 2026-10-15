import {it,expect} from 'vitest';
import {summarizeTests} from './verification-test-evidence.mjs';
it('retains exact failed assertions, stack frames and setup-blocked case names without exposing credentials',()=>{
 const jwt='eyJ'+'a'.repeat(20)+'.'+'b'.repeat(30)+'.'+'c'.repeat(30);
 const raw={success:false,numTotalTests:3,numPassedTests:1,numFailedTests:1,numPendingTests:1,numTodoTests:0,numFailedTestSuites:1,testResults:[{name:'apps/search/test.ts',status:'failed',message:'setup connection failed',assertionResults:[{fullName:'passes',status:'passed'},{fullName:'exact proof case',status:'failed',failureMessages:['AssertionError: expected 202, got 503\n    at proof.ts:12:3\npostgresql://user:private-password@localhost/db\n'+jwt]},{fullName:'blocked proof case',status:'skipped'}]}]};
 const evidence=summarizeTests(raw);expect(evidence.counts).toMatchObject({numTotalTests:3,numFailedTests:1,numPendingTests:1});expect(evidence.failures[0]).toMatchObject({name:'exact proof case',status:'failed'});expect(evidence.failures[0].errors[0]).toContain('expected 202, got 503');expect(evidence.failures[0].errors[0]).toContain('at proof.ts:12:3');expect(evidence.unexecuted).toEqual([{file:'apps/search/test.ts',name:'blocked proof case',status:'skipped'}]);expect(evidence.suiteErrors[0].message).toBe('setup connection failed');expect(JSON.stringify(evidence)).not.toContain('private-password');expect(JSON.stringify(evidence)).not.toContain(jwt);expect(evidence.truncated).toBe(false);
});
it('marks truncated diagnostics instead of silently claiming complete evidence',()=>{
 const evidence=summarizeTests({success:false,testResults:[{name:'proof.ts',assertionResults:[{fullName:'large failure',status:'failed',failureMessages:['x'.repeat(20000)]}]}]});expect(evidence.truncated).toBe(true);expect(evidence.failures[0].errors[0].length).toBeLessThan(8300);expect(evidence.failures[0].errors[0]).toContain('[truncated]');
});
