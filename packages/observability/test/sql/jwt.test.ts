import {beforeAll,it,expect} from 'vitest';
import {generateKeyPair,exportSPKI,SignJWT} from 'jose';
import {createTokenVerifier} from '@ecommerce/security';
import express from 'express';
import request from 'supertest';
import {sqlReporting} from '../../src/sql-reporting.js';
let app:express.Express,key:Awaited<ReturnType<typeof generateKeyPair>>;
beforeAll(async()=>{key=await generateKeyPair('RS256');const verify=await createTokenVerifier(await exportSPKI(key.publicKey),{issuer:'phase18-test',audience:'internal-test'});app=express();app.use('/internal/sql',sqlReporting(verify));});
async function token(role='admin',issuer='phase18-test',expiration='1m'){return new SignJWT({role}).setProtectedHeader({alg:'RS256'}).setSubject('00000000-0000-4000-8000-000000000001').setIssuer(issuer).setAudience('internal-test').setIssuedAt().setExpirationTime(expiration).sign(key.privateKey);}
it('accepts a cryptographically verified admin token for sanitized reporting only',async()=>{const result=await request(app).get('/internal/sql').set('Authorization','Bearer '+await token()).expect(200);expect(result.headers['cache-control']).toBe('no-store');expect(result.body.queries).toBeDefined();await request(app).post('/internal/sql/explain').set('Authorization','Bearer '+await token()).send({queryId:'catalog.product-by-id'}).expect(503);});
it('denies valid customers, expired tokens, wrong issuer and forged admin claims',async()=>{
 await request(app).get('/internal/sql').set('Authorization','Bearer '+await token('customer')).expect(403);
 for(const invalid of [await token('admin','wrong-issuer'),await token('admin','phase18-test','-1m'),'eyJhbGciOiJub25lIn0.eyJyb2xlIjoiYWRtaW4ifQ.invalid'])await request(app).get('/internal/sql').set('Authorization','Bearer '+invalid).expect(401);
});
