import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import express from 'express';
import request from 'supertest';
import {it,expect} from 'vitest';
import {SqlDiagnostics} from '../../src/sql-diagnostics.js';
import {SqlAdvisor,advisorConfig} from '../../src/sql-advisor.js';
import {sqlAdvisorReporting} from '../../src/sql-advisor-reporting.js';
it('advises over approved real PostgreSQL plans and preserves rows during malicious enrichment',async()=>{
 const fixture=JSON.parse(await readFile(process.env.PHASE18_PG_FIXTURE_FILE!,'utf8'));
 const {project:_,...connection}=fixture;
 const admin=new Pool({...connection,max:1}),db=new Pool({...connection,database:'phase19_advisor_test',max:1});let readonly:Pool|undefined;
 try{
  await admin.query('CREATE DATABASE phase19_advisor_test');
  await admin.query("CREATE ROLE sql_diag_advisor LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'isolated_advisor_test'");
  await db.query('REVOKE ALL ON DATABASE phase19_advisor_test FROM PUBLIC');await db.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');await db.query('GRANT CONNECT ON DATABASE phase19_advisor_test TO sql_diag_advisor');await db.query('GRANT USAGE ON SCHEMA public TO sql_diag_advisor');await db.query('CREATE TABLE public.products(id uuid PRIMARY KEY, private_value text)');await db.query("INSERT INTO products VALUES ('00000000-0000-4000-8000-000000000001','sensitive-row')");await db.query('GRANT SELECT ON products TO sql_diag_advisor');await db.query('ALTER ROLE sql_diag_advisor SET default_transaction_read_only = on');
  readonly=new Pool({...connection,database:'phase19_advisor_test',user:'sql_diag_advisor',password:'isolated_advisor_test',max:1,statement_timeout:1000});
  const advisor=new SqlAdvisor({...advisorConfig({}),enabled:true},{identity:'malicious-test',analyze:async()=>({sql:'DROP TABLE products'})});
  const app=express();app.use('/internal/sql-advisor',sqlAdvisorReporting(async()=>({role:'admin'}),advisor,new SqlDiagnostics(readonly,'catalog')));
  const response=await request(app).post('/internal/sql-advisor/analyze').send({queryId:'catalog.product-by-id'});expect(response.status).toBe(200);expect(response.body.failure).toBe('invalid_response');expect(response.body.recommendation.version).toBe(1);expect(JSON.stringify(response.body)).not.toMatch(/sensitive-row|DROP TABLE/);expect((await db.query('SELECT private_value FROM products')).rows).toEqual([{private_value:'sensitive-row'}]);
 }finally{await readonly?.end();await db.end();await admin.end();}
});
