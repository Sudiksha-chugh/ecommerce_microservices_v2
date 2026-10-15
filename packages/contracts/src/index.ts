export interface HealthResponse {
  status: 'ok';
  service: 'api-gateway' | 'catalog-service' | 'auth-service' | 'cart-service' | 'orders-service' | 'inventory-service';
}

export interface ErrorResponse {
  error: { message: string };
}

export interface Product {
  id: string;
  name: string;
  description: string;
  priceInPaise: number;
}

export interface PublicUser {
  id: string;
  email: string;
  role: 'customer' | 'admin';
}

export interface Cart {
  items: Array<{ productId: string; quantity: number }>;
}

export interface OrderItem {
  productId: string; productName: string; unitPriceInPaise: number;
  quantity: number; lineTotalInPaise: number;
}
export interface OrderSummary {
  id: string; userId: string; status: 'PENDING' | 'CONFIRMED' | 'FAILED' | 'CANCELLED'; totalAmountInPaise: number;
  createdAt: string; updatedAt: string;
}
export interface Order extends OrderSummary { items: OrderItem[] }

export interface InventoryStock { productId: string; totalStock: number; reservedStock: number; availableStock: number }
export type ReservationStatus = 'RESERVED' | 'CONFIRMED' | 'RELEASED' | 'EXPIRED' | 'RESTORED';
export interface ReservationGroup {
  orderId: string; status: ReservationStatus; expiresAt: string;
  items: Array<{ id: string; productId: string; quantity: number; status: ReservationStatus; expiresAt: string }>;
}
