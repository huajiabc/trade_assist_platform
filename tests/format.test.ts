import { expect, it } from 'vitest';
import { formatPrice } from '../shared/format';

it('preserves distinct tiny instrument prices in visible text', () => {
  expect(Number(formatPrice(1.1e-10, false))).toBe(1.1e-10);
  expect(formatPrice(1.1e-10)).not.toBe(formatPrice(9e-11));
  expect(formatPrice(0.00054321)).toBe('0.00054321');
  expect(formatPrice(63_818.23)).toBe('63,818.23');
});
