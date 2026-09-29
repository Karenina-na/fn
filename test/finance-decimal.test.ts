import assert from 'node:assert/strict';
import test from 'node:test';
import { Decimal } from '../src/finance/decimal.ts';

test('decimal arithmetic preserves financial quantities without binary floating point', () => {
  assert.equal(Decimal.parse('0.1').add(Decimal.parse('0.2')).toString(), '0.3');
  assert.equal(Decimal.parse('0.00000001').multiply(Decimal.parse('100000000')).toString(), '1');
  assert.equal(Decimal.parse('50').multiply(Decimal.parse('180.125')).toString(), '9006.25');
  assert.equal(Decimal.parse('1000').subtract(Decimal.parse('2.25')).toString(), '997.75');
});

test('decimal input is canonical and rejects non-finite or ambiguous values', () => {
  assert.equal(Decimal.parse('-0.00').toString(), '0');
  assert.equal(Decimal.parse('001.2300').toString(), '1.23');
  for (const value of ['', ' 1', '1e3', 'NaN', 'Infinity', '1.']) {
    assert.throws(() => Decimal.parse(value));
  }
});
