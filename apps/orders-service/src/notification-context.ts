import type {Pool} from 'pg';
export async function orderNotificationContext(pool:Pool,orderId:string){return (await pool.query(`SELECT o.id AS "orderId",o.user_id AS "userId",o.status,o.total_amount_paise::text AS "amountPaise",COALESCE(s.version,0)::text AS version FROM orders o LEFT JOIN checkout_sagas s ON s.order_id=o.id WHERE o.id=$1`,[orderId])).rows[0];}
