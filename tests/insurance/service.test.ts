import { test, expect } from 'vitest';
import { InsuranceService } from '../../src/services/insurance';

test('InsuranceService can be instantiated', () => {
  const service = new InsuranceService({
    prisma: {} as any,
    cubecover: {} as any,
  });
  expect(service).toBeDefined();
});