// Sequential ticks; stop drains the current tick before its database pool closes.
export function pollWorker(run:()=>Promise<unknown>,intervalMs=1000,component='checkout-worker'){
 let stopped=false,timer:ReturnType<typeof setTimeout>|undefined,active:Promise<unknown>|undefined;
 function tick(){active=run().catch(()=>console.error(JSON.stringify({component,outcome:'retry_after_failure'}))).finally(()=>{active=undefined;if(!stopped){timer=setTimeout(tick,intervalMs);timer.unref();}});}
 tick();return {async stop(){stopped=true;clearTimeout(timer);await active;}};
}
