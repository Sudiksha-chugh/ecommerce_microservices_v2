import type { TokenVerifier } from '@ecommerce/security';
import { requireAdmin } from './middleware/require-admin.js';
import express from 'express';
import type { ErrorResponse, HealthResponse } from '@ecommerce/contracts';
import { createProductSchema, updateProductSchema, productIdSchema } from './product-validation.js';
import type { ProductRepository } from './product-repository.js';
import { errorHandler } from './middleware/error-handler.js';

export function createApp(repository: Pick<ProductRepository, 'findAll' | 'findById' | 'create' | 'update' | 'delete'>, verifyToken: TokenVerifier) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_request, response) => {
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
