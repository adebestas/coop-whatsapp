import fetch from 'node-fetch';

export interface CubeCoverConfig {
  apiKey: string;
  baseUrl: string;
}

export interface Product {
  code: string;
  name: string;
  description: string;
  plans: Plan[];
}

export interface Plan {
  code: string;
  name: string;
  premiumKobo: number;
  coverageKobo: number;
}

export interface Policy {
  id: string;
  productCode: string;
  planCode: string;
  status: string;
  startDate: string;
  endDate?: string;
}

export interface Claim {
  id: string;
  policyId: string;
  claimType: string;
  amountKobo: number;
  status: string;
}

export interface CubeCoverEvent {
  event: string;
  data: Record<string, unknown>;
}

export class CubeCoverClient {
  private config: CubeCoverConfig;

  constructor(config: CubeCoverConfig) {
    this.config = config;
  }

  private async request(path: string, options: RequestInit = {}): Promise<unknown> {
    const url = `${this.config.baseUrl}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`CubeCover API error: ${response.status} ${response.statusText} - ${errorBody}`);
    }
    return response.json();
  }

  async getProducts(): Promise<Product[]> {
    return this.request('/v1/products');
  }

  async getProduct(code: string): Promise<Product> {
    return this.request(`/v1/products/${code}`);
  }

  async createQuote(params: { productCode: string; planCode: string; memberId: string }): Promise<{ quoteId: string; premiumKobo: number }> {
    return this.request('/v1/quotes', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  async purchasePolicy(params: { quoteId: string; memberId: string; paymentRef: string }): Promise<Policy> {
    return this.request('/v1/policies', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  async getPolicy(id: string): Promise<Policy> {
    return this.request(`/v1/policies/${id}`);
  }

  async cancelPolicy(id: string): Promise<void> {
    await this.request(`/v1/policies/${id}/cancel`, { method: 'POST' });
  }

  async renewPolicy(id: string): Promise<Policy> {
    return this.request(`/v1/policies/${id}/renew`, { method: 'POST' });
  }

  async submitClaim(params: { policyId: string; claimType: string; amountKobo: number; description?: string; documents?: string[] }): Promise<Claim> {
    return this.request('/v1/claims', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  async getClaim(id: string): Promise<Claim> {
    return this.request(`/v1/claims/${id}`);
  }

  async listClaims(policyId: string): Promise<Claim[]> {
    return this.request(`/v1/claims?policy_id=${policyId}`);
  }

  verifyWebhook(rawBody: string, signature: string): boolean {
    const crypto = require('crypto');
    const expected = crypto
      .createHmac('sha256', process.env.CUBECOVER_WEBHOOK_SECRET || '')
      .update(rawBody)
      .digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  }

  parseNotification(body: unknown): CubeCoverEvent | null {
    if (typeof body === 'object' && body !== null && 'event' in body) {
      return body as CubeCoverEvent;
    }
    return null;
  }
}