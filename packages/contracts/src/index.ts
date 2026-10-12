export interface HealthResponse {
  status: 'ok';
  service: 'api-gateway' | 'catalog-service' | 'auth-service' | 'cart-service' | 'orders-service';
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
  id: string; userId: string; status: 'PENDING'; totalAmountInPaise: number;
  createdAt: string; updatedAt: string;
}
export interface Order extends OrderSummary { items: OrderItem[] }
