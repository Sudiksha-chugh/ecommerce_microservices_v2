import {z} from 'zod';
const id='00000000-0000-4000-8000-000000000001';
export const httpContracts=[
 {provider:'catalog',path:`/products/${id}`,auth:'public',schema:z.object({id:z.uuid(),name:z.string(),description:z.string(),priceInPaise:z.number().int()})},
 {provider:'auth',path:'/auth/me',auth:'bearer',schema:z.object({id:z.uuid(),email:z.email(),role:z.enum(['customer','admin'])})},
 {provider:'cart',path:'/cart',auth:'bearer',schema:z.object({items:z.array(z.object({productId:z.uuid(),quantity:z.number().int()}))})},
 {provider:'orders',path:`/orders/${id}`,auth:'bearer',schema:z.object({id:z.uuid(),userId:z.uuid(),status:z.enum(['PENDING','CONFIRMED','FAILED','CANCELLED']),totalAmountInPaise:z.number().int(),items:z.array(z.unknown()),createdAt:z.iso.datetime(),updatedAt:z.iso.datetime()})},
 {provider:'inventory',path:`/inventory/${id}`,auth:'public',schema:z.object({productId:z.uuid(),totalStock:z.number().int(),reservedStock:z.number().int(),availableStock:z.number().int()})},
 {provider:'payments',path:`/payments/${id}`,auth:'bearer',schema:z.object({paymentId:z.uuid(),orderId:z.uuid(),status:z.enum(['CREATED','PROCESSING','SUCCEEDED','FAILED','REQUIRES_RECONCILIATION']),amountPaise:z.number().int(),currency:z.literal('INR')})},
] as const;
