// Cooperative cancellation plus a hard caller-side deadline. Rejections are observed
// even when an adapter violates its cancellation contract. Adapters must not launch
// detached work: cancellation cannot undo arbitrary third-party side effects.
export async function bounded<T>(signal:AbortSignal,operation:()=>Promise<T>):Promise<T>{
 signal.throwIfAborted();let onAbort:()=>void=()=>{};
 const cancelled=new Promise<never>((_resolve,reject)=>{onAbort=()=>reject(new Error('DEADLINE'));signal.addEventListener('abort',onAbort,{once:true});});
 try{return await Promise.race([Promise.resolve().then(()=>{signal.throwIfAborted();return operation();}),cancelled]);}
 finally{signal.removeEventListener('abort',onAbort);}
}
