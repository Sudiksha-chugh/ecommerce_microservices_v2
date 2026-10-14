// Read-only, sanitized diagnostics. Uses only established test roles/vhost.
import {readFile} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {Pool} from 'pg';
const output={runtime:process.version,at:new Date().toISOString(),postgres:{},rabbitmq:{}};
for(const service of ['orders','inventory','payments']){
 const env=parseEnv(await readFile(`.env.${service}`,'utf8')),prefix=service.toUpperCase();
 const pool=new Pool({host:env[`${prefix}_PGHOST`]??'127.0.0.1',port:Number(env[`${prefix}_PGPORT`]??5432),database:`${service}_test_db`,user:`${service}_test_user`,password:env[`${prefix}_TEST_PASSWORD`],max:1,connectionTimeoutMillis:2000,statement_timeout:2000});
 try{output.postgres[service]={maxConnections:(await pool.query('SHOW max_connections')).rows[0].max_connections,activity:(await pool.query("SELECT state,wait_event_type,count(*)::int AS connections FROM pg_stat_activity WHERE datname=current_database() AND usename=current_user GROUP BY state,wait_event_type")).rows};}catch{output.postgres[service]={unavailable:true};}finally{await pool.end();}
}
const env=parseEnv(await readFile('.env.messaging','utf8')),origin=`http://127.0.0.1:${env.RABBITMQ_MANAGEMENT_PORT??15673}/api/`,authorization='Basic '+Buffer.from(`${env.RABBITMQ_ADMIN_USER}:${env.RABBITMQ_ADMIN_PASSWORD}`).toString('base64');
try{
 const get=async path=>{const r=await fetch(origin+path,{headers:{authorization},signal:AbortSignal.timeout(5000)});if(!r.ok){await r.body?.cancel();throw new Error('Management unavailable');}return r.json();};
 const [overview,nodes,connections,channels,queues]=await Promise.all([get('overview'),get('nodes'),get('connections'),get('channels'),get('queues/commerce_test')]);
 output.rabbitmq={version:overview.rabbitmq_version,totals:overview.object_totals,nodes:nodes.map(n=>Object.fromEntries(['mem_alarm','disk_free_alarm','fd_used','fd_total','proc_used','proc_total','run_queue'].map(k=>[k,n[k]]))),testConnections:connections.filter(c=>c.vhost==='commerce_test').map(c=>({state:c.state,channels:c.channels})),testChannels:channels.filter(c=>c.vhost==='commerce_test').map(c=>({consumerCount:c.consumer_count,unacknowledged:c.messages_unacknowledged,unconfirmed:c.messages_unconfirmed})),testQueues:queues.map(q=>({name:q.name,state:q.state,consumers:q.consumers,messages:q.messages}))};
}catch{output.rabbitmq={unavailable:true};}
console.log(JSON.stringify(output,null,2));
