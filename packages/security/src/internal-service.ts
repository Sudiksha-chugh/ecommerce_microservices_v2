import {createHmac,timingSafeEqual} from 'node:crypto';
import type {IncomingHttpHeaders} from 'node:http';
function digest(method:string,path:string,time:string,key:string,caller:string){return createHmac('sha256',key).update(`${caller}\n${method}\n${path}\n${time}`).digest('hex');}
export function internalHeaders(method:string,path:string,key:string,now=Date.now(),caller:'notifications'|'search'='notifications'){if(key.length<32)throw new Error('Internal lookup key must contain at least 32 characters');const time=String(Math.floor(now/1000));return {'x-service-name':caller,'x-service-time':time,'x-service-signature':digest(method,path,time,key,caller)};}
export function verifyInternalRequest(headers:IncomingHttpHeaders,method:string,path:string,key:string,now=Date.now(),caller:'notifications'|'search'='notifications'){
 const time=headers['x-service-time'],signature=headers['x-service-signature'];
 if(key.length<32||headers['x-service-name']!==caller||typeof time!=='string'||!/^\d{10,12}$/.test(time)||Math.abs(now/1000-Number(time))>30||typeof signature!=='string'||!/^[a-f0-9]{64}$/.test(signature))return false;
 return timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(digest(method,path,time,key,caller),'hex'));
}
