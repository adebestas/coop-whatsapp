import { test, expect } from 'vitest';
import { CubeCoverClient } from '../../src/services/insurance/cubecover';

test('CubeCoverClient.getProducts returns product list', async () => {
  const client = new CubeCoverClient({ apiKey: 'test', baseUrl: 'https://api.cubecover.ai' });
  const products = await client.getProducts();
  expect(Array.isArray(products)).toBe(true);
});

test('CubeCoverClient.getProduct returns product details', async () => {
  const client = new CubeCoverClient({ apiKey: 'test', baseUrl: 'https://api.cubecover.ai' });
  const product = await client.getProduct('supercare');
  expect(product).toBeDefined();
  expect(product.code).toBe('supercare');
});

test('CubeCoverClient.verifyWebhook verifies valid signature', async () => {
  const client = new CubeCoverClient({ apiKey: 'test', baseUrl: 'https://api.cubecover.ai' });
  const body = JSON.stringify({ event: 'test', data: {} });
  const expectedSig = crypto
    .createHmac('sha256', 'test-secret')
    .update(body)
    .digest('hex');
  expect(client.verifyWebhook(body, expectedSig)).toBe(true);
});

test('CubeCoverClient.parseNotification parses valid event', async () => {
  const client = new CubeCoverClient({ apiKey: 'test', baseUrl: 'https://api.cubecover.ai' });
  const result = client.parseNotification({ event: 'policy.created', data: {} });
  expect(result).toBeDefined();
  expect(result?.event).toBe('policy.created');
});