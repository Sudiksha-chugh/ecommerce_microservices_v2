import {committed,rolledBack} from '@ecommerce/observability';
import {correlation} from '@ecommerce/observability';
import type {Pool,PoolClient} from 'pg';
export type Logger=(record:Record<string,unknown>) => void;
export const defaultLogger:Logger=(record) => console.info(JSON.stringify(record));
export function log(logger:Logger,record:Record<string,unknown>){try{logger({...record,...correlation()});}catch{/* Logs never change transaction outcomes. */}}
export class PersistenceError extends Error {constructor(){super('Event persistence unavailable; transaction outcome may be uncertain');}}
export async function transaction<T>(pool:Pool,operation:(client:PoolClient) => Promise<T>):Promise<T>{
 let client:PoolClient;try{client=await pool.connect();}catch{throw new PersistenceError();}let broken=false;
 const onClientError = () => { broken = true; }; client.on('error', onClientError);
 try{await client.query('BEGIN');const result=await operation(client);await client.query('COMMIT');committed(client);return result;}
 catch(error){try{await client.query('ROLLBACK');rolledBack(client);}catch{broken=true;}if(error instanceof PersistenceError)throw error;throw new PersistenceError();}
 finally{rolledBack(client);client.release(broken); client.off('error', onClientError);}
}
