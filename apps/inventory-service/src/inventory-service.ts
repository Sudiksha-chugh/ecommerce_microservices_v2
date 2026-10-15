import {observeBusiness} from '@ecommerce/observability';
import type { InventoryRepository } from './inventory-repository.js';
import type { CatalogClient } from './catalog-client.js';
import type { ReservationInput } from './inventory-validation.js';
export class InventoryService {
  constructor(private readonly inventory: InventoryRepository, private readonly catalog: CatalogClient) {}
  find(productId: string) { return this.inventory.find(productId); }
  async put(productId: string, totalStock: number) {
    await this.catalog.requireProduct(productId); return this.inventory.put(productId, totalStock);
  }
  async reserve(input: ReservationInput) {observeBusiness('reservation_attempt');try{const result=await this.inventory.reserve(input);observeBusiness('reservation_success','success');return result;}catch(error){observeBusiness('reservation_failure','error');throw error;}}
  confirm(orderId: string) { return this.inventory.finish(orderId, 'CONFIRMED'); }
  release(orderId: string) { return this.inventory.finish(orderId, 'RELEASED'); }
}
