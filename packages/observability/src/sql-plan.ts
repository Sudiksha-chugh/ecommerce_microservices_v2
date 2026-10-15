// Deliberately excludes relations, indexes, aliases, expressions, conditions and settings.
const nodeTypes=new Set(['Seq Scan','Index Scan','Index Only Scan','Bitmap Heap Scan','Bitmap Index Scan','Sort','Incremental Sort','Nested Loop','Hash Join','Merge Join','Hash','Aggregate','Limit','Gather','Gather Merge','Append','Result','Materialize','Unique','Subquery Scan']);
export interface PlanNode {id:number;parent:number|null;type:string;estimatedCost:number;estimatedRows:number;estimatedWidth:number}
export interface PlanFinding {node:number;code:'sequential_scan'|'expensive_sort'|'join'|'review_filter_index'|'review_sort_index'|'review_join_indexes';severity:'information'|'review'}
export function analyzeSqlPlan(input:unknown){
 if(!Array.isArray(input)||input.length!==1||!input[0]||typeof input[0]!=='object')throw new Error('Invalid diagnostic plan');
 const root=(input[0] as Record<string,unknown>).Plan;
 const nodes:PlanNode[]=[],findings:PlanFinding[]=[];
 const finite=(n:unknown)=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1e15?n:0;
 function visit(raw:unknown,parent:number|null,depth:number){
  if(depth>32||nodes.length>=128||!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Diagnostic plan exceeds bounds');
  const value=raw as Record<string,unknown>,id=nodes.length,type=typeof value['Node Type']==='string'&&nodeTypes.has(value['Node Type'])?value['Node Type']:'Other';
  const node={id,parent,type,estimatedCost:finite(value['Total Cost']),estimatedRows:finite(value['Plan Rows']),estimatedWidth:finite(value['Plan Width'])};nodes.push(node);
  if(type==='Seq Scan'){findings.push({node:id,code:'sequential_scan',severity:'information'});if(node.estimatedRows>=1000&&typeof value.Filter==='string')findings.push({node:id,code:'review_filter_index',severity:'review'});}
  if((type==='Sort'||type==='Incremental Sort')&&node.estimatedCost>=1000){findings.push({node:id,code:'expensive_sort',severity:'review'},{node:id,code:'review_sort_index',severity:'review'});}
  if(['Nested Loop','Hash Join','Merge Join'].includes(type)){findings.push({node:id,code:'join',severity:node.estimatedCost>=1000?'review':'information'});if(node.estimatedCost>=1000)findings.push({node:id,code:'review_join_indexes',severity:'review'});}
  if(value.Plans!==undefined){if(!Array.isArray(value.Plans))throw new Error('Invalid diagnostic plan');for(const child of value.Plans)visit(child,id,depth+1);}
 }
 visit(root,null,0);return {version:1,estimatedOnly:true,nodes,findings};
}
