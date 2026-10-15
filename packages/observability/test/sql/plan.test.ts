import {it,expect} from 'vitest';
import {analyzeSqlPlan} from '../../src/sql-plan.js';
it('deterministically classifies scans, sorts, joins and advisory opportunities without content',()=>{
 const raw=[{Plan:{'Node Type':'Hash Join','Total Cost':5000,'Plan Rows':10000,'Hash Cond':'customer_secret = password',Plans:[{'Node Type':'Seq Scan','Relation Name':'private_users',Filter:"email='customer_secret'",'Total Cost':2000,'Plan Rows':2000},{'Node Type':'Sort','Sort Key':['sensitive'],'Total Cost':1500,'Plan Rows':5000,'Index Name':'secret'}]}}];
 const result=analyzeSqlPlan(raw);expect(result).toEqual(analyzeSqlPlan(raw));expect(result.findings.map(x=>x.code)).toEqual(['join','review_join_indexes','sequential_scan','review_filter_index','expensive_sort','review_sort_index']);expect(result.nodes[1]!.parent).toBe(0);expect(JSON.stringify(result)).not.toMatch(/customer_secret|password|private_users|email|sensitive|secret/);expect(result.estimatedOnly).toBe(true);
});
it('does not label a small sequential scan as an index defect',()=>{expect(analyzeSqlPlan([{Plan:{'Node Type':'Seq Scan','Plan Rows':2,Filter:'private'}}]).findings.map(x=>x.code)).toEqual(['sequential_scan']);});
it('rejects excessive trees and invalid documents, bounds numeric and node values',()=>{
 let node:Record<string,unknown>={'Node Type':'Result'};for(let i=0;i<34;i++)node={'Node Type':'Result',Plans:[node]};expect(()=>analyzeSqlPlan([{Plan:node}])).toThrow();expect(()=>analyzeSqlPlan([{Plan:{Plans:Array(129).fill({})}}])).toThrow();expect(()=>analyzeSqlPlan([])).toThrow();expect(analyzeSqlPlan([{Plan:{'Node Type':'secret','Total Cost':Infinity,'Plan Rows':-2}}]).nodes[0]).toMatchObject({type:'Other',estimatedCost:0,estimatedRows:0});
});
