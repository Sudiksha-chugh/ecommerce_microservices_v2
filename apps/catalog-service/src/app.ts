import {httpTelemetry} from '@ecommerce/observability';
import { verifyInternalRequest } from '@ecommerce/security';
import { z } from 'zod';
import { CatalogSearchSource, exportQuery } from './search-source.js';
import type { TokenVerifier } from '@ecommerce/security';
import { requireAdmin } from './middleware/require-admin.js';
import express from 'express';
import type { ErrorResponse, HealthResponse } from '@ecommerce/contracts';
import { createProductSchema, updateProductSchema, productIdSchema } from './product-validation.js';
import type { ProductRepository } from './product-repository.js';
import { errorHandler } from './middleware/error-handler.js';

export function createApp(repository: Pick<ProductRepository, 'findAll' | 'findById' | 'create' | 'update' | 'delete'>, verifyToken: TokenVerifier, searchSource?: CatalogSearchSource, searchKey = '') {
  const app = express();app.use(httpTelemetry('catalog-service'));
  app.disable('x-powered-by');

  app.get(['/internal/catalog/search-watermark','/internal/catalog/search-export','/internal/catalog/search-visible','/internal/catalog/search-documents'], async(req,res)=>{
    if(!searchSource){res.status(404).json({error:{message:'Route not found'}});return;}
    res.set('Cache-Control','no-store');
    if(!verifyInternalRequest(req.headers,req.method,req.originalUrl,searchKey,Date.now(),'search')){res.status(401).json({error:{message:'Unauthorized'}});return;}
    if(req.path.endsWith('search-watermark')){res.json({watermark:await searchSource.watermark()});return;}
    if(req.path.endsWith('search-visible')||req.path.endsWith('search-documents')){
      const parsed=z.strictObject({ids:z.string().max(3700).transform(v=>v.split(',')).pipe(z.array(z.uuid()).min(1).max(100))}).safeParse(req.query);
      if(!parsed.success){res.status(400).json({error:{message:'Invalid visibility request'}});return;}
      res.json(req.path.endsWith('search-visible')?{ids:await searchSource.visible(parsed.data.ids)}:{documents:await searchSource.documents(parsed.data.ids)});return;
    }
    const parsed=exportQuery.safeParse(req.query);
    if(!parsed.success){res.status(400).json({error:{message:'Invalid export query'}});return;}
    res.json({rows:await searchSource.export(parsed.data)});
  });
  app.get('/health' , (_request, response) => {
    const body: HealthResponse = { status: 'ok', service: 'catalog-service' };
    response.status(200).json(body);
  });
  app.get('/products', async (_request, response) => {
    response.status(200).json(await repository.findAll());
  });
  app.get('/products/:id', async (request, response) => {
    const id = productIdSchema.safeParse(request.params.id);
    if (!id.success) {
      response.status(400).json({ error: { message: 'Invalid product ID' } });
      return;
    }
    const product = await repository.findById(id.data);
    if (!product) {
      const body: ErrorResponse = { error: { message: 'Product not found' } };
      response.status(404).json(body);
      return;
    }
    response.status(200).json(product);
  });
  app.post('/products', requireAdmin(verifyToken), express.json(), async (request, response) => {
    const input = createProductSchema.safeParse(request.body);
    if (!input.success) {
      response.status(400).json({ error: { message: 'Invalid product body' } });
      return;
    }
    const product = await repository.create(input.data);
    response.status(201).location(`/products/${product.id}`).json(product);
  });
  app.patch('/products/:id', requireAdmin(verifyToken), express.json(), async (request, response) => {
    const id = productIdSchema.safeParse(request.params.id);
    if (!id.success) {
      response.status(400).json({ error: { message: 'Invalid product ID' } });
      return;
    }
    const input = updateProductSchema.safeParse(request.body);
    if (!input.success) {
      response.status(400).json({ error: { message: 'Invalid product body' } });
      return;
    }
    const product = await repository.update(id.data, input.data);
    if (!product) {
      response.status(404).json({ error: { message: 'Product not found' } });
      return;
    }
    response.status(200).json(product);
  });
  app.delete('/products/:id', requireAdmin(verifyToken), async (request, response) => {
    const id = productIdSchema.safeParse(request.params.id);
    if (!id.success) {
      response.status(400).json({ error: { message: 'Invalid product ID' } });
      return;
    }
    if (!await repository.delete(id.data)) {
      response.status(404).json({ error: { message: 'Product not found' } });
      return;
    }
    response.status(204).end();
  });
  app.use((_request, response) => {
    const body: ErrorResponse = { error: { message: 'Route not found' } };
    response.status(404).json(body);
  });
  app.use(errorHandler);
  return app;
}
