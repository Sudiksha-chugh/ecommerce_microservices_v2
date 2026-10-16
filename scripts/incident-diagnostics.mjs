import {startIncidentDiagnostics} from '../packages/observability/src/incident/server.ts';
const listener=await startIncidentDiagnostics();
if(listener)for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await listener.close();});
