import {it,expect} from 'vitest';
import {CartRepository} from '../../apps/cart-service/src/cart-repository.js';
import type {CartRedisClient} from '../../apps/cart-service/src/redis/client.js';
it('bounds an established Redis socket whose reply never arrives',async()=>{
 const client={isReady:true,withCommandOptions:()=>({hGetAll:()=>new Promise(()=>{})})} as unknown as CartRedisClient;
 const repository=new CartRepository(client,60,15);await expect(repository.find('owned-test-user')).rejects.toMatchObject({status:503,message:'Cart storage unavailable'});
});
