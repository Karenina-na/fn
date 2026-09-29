import assert from 'node:assert/strict';
import test from 'node:test';
import { Ledger, validatePostings, validateTime } from '../src/finance/ledger.ts';

const at = '2026-09-29T00:00:00Z';

test('financial timestamps reject impossible calendar dates', () => {
  assert.throws(() => validateTime('2026-02-30T00:00:00Z'), /invalid timestamp/);
});

test('accepted ledger cannot include events that have not happened yet', () => {
  const ledger = new Ledger('book', 'owner', () => '2026-10-01T00:00:00Z', () => 'currency');
  assert.throws(() => ledger.recordOperation({ kind: 'deposit', occurredAt: '2026-10-02T00:00:00Z' }, {
    effectiveAt: '2026-10-02T00:00:00Z', postings: [
      { account: 'asset', bucketId: 'cash', instrumentId: 'USD', quantity: '100' },
      { account: 'external', instrumentId: 'USD', quantity: '-100' },
    ],
  }), /future event/);
  assert.equal(ledger.entries().length, 0);
});

test('journal entries balance independently for every instrument', () => {
  assert.doesNotThrow(() => validatePostings([
    { account: 'asset', bucketId: 'source', instrumentId: 'USD', quantity: '-1000' },
    { account: 'trading', instrumentId: 'USD', quantity: '1000' },
    { account: 'trading', instrumentId: 'EUR', quantity: '-920' },
    { account: 'asset', bucketId: 'target', instrumentId: 'EUR', quantity: '920' },
  ]));
  assert.throws(() => validatePostings([
    { account: 'asset', bucketId: 'source', instrumentId: 'USD', quantity: '-1000' },
    { account: 'asset', bucketId: 'target', instrumentId: 'EUR', quantity: '920' },
  ]), /unbalanced/);
});

test('ledger keeps immutable entries, effective time and recorded time', () => {
  const ledger = new Ledger('book', 'owner', () => '2026-09-29T12:00:00.000Z', () => 'currency');
  const operation = ledger.recordOperation({ kind: 'opening_balance', occurredAt: '2026-09-28T00:00:00Z', source: 'statement', reference: 'line-1' }, {
    effectiveAt: '2026-09-28T00:00:00Z', postings: [
      { account: 'asset', bucketId: 'bucket', instrumentId: 'USD', quantity: '100' },
      { account: 'equity', instrumentId: 'USD', quantity: '-100' },
    ],
  });
  assert.equal(operation.createdAt, '2026-09-29T12:00:00.000Z');
  assert.equal(operation.bookId, 'book');
  assert.equal(operation.ownerId, 'owner');
  assert.equal(operation.entries[0]?.effectiveAt, '2026-09-28T00:00:00Z');
  operation.entries[0]!.postings[0]!.quantity = '999';
  assert.equal(ledger.listOperations()[0]?.entries[0]?.postings[0]?.quantity, '100');
  assert.equal(ledger.entries('2026-09-27T23:59:59Z').length, 0);
});

test('late-arriving transfer receipts replay by effective time after newer operations', () => {
  const ledger = new Ledger('book', 'owner', () => '2026-10-04T00:00:00Z', () => 'currency');
  const transfer = ledger.recordOperation({ kind: 'transfer', occurredAt: '2026-10-01T00:00:00Z', transfer: {
    sourceBucketId: 'a', destinationBucketId: 'b', instrumentId: 'USD', quantity: '5', fee: '0',
  } }, { effectiveAt: '2026-10-01T00:00:00Z', postings: [
    { account: 'asset', bucketId: 'a', instrumentId: 'USD', quantity: '-5' },
    { account: 'transit', instrumentId: 'USD', quantity: '5' },
  ] });
  ledger.recordOperation({ kind: 'deposit', occurredAt: '2026-10-02T00:00:00Z' }, {
    effectiveAt: '2026-10-04T00:00:00Z', postings: [
      { account: 'asset', bucketId: 'a', instrumentId: 'USD', quantity: '1' },
      { account: 'external', instrumentId: 'USD', quantity: '-1' },
    ],
  });
  ledger.appendEntry(transfer.id, { effectiveAt: '2026-10-03T00:00:00Z', postings: [
    { account: 'transit', instrumentId: 'USD', quantity: '-5' },
    { account: 'asset', bucketId: 'b', instrumentId: 'USD', quantity: '5' },
  ] });
  assert.deepEqual(ledger.entries().map(entry => entry.effectiveAt), [
    '2026-10-01T00:00:00Z', '2026-10-03T00:00:00Z', '2026-10-04T00:00:00Z',
  ]);
  assert.throws(() => ledger.recordOperation({ kind: 'deposit', occurredAt: '2026-10-02T12:00:00Z' }, {
    effectiveAt: '2026-10-02T12:00:00Z', postings: [
      { account: 'asset', bucketId: 'a', instrumentId: 'USD', quantity: '1' },
      { account: 'external', instrumentId: 'USD', quantity: '-1' },
    ],
  }), /backdated/);
});

test('ledger rejects non-currency asset changes without matching lot facts', () => {
  const ledger = new Ledger('book', 'owner', () => '2026-10-01T00:00:00Z',
    instrumentId => instrumentId === 'SHARE' ? 'equity' : 'currency');
  assert.throws(() => ledger.recordOperation({ kind: 'opening_position', occurredAt: '2026-09-29T00:00:00Z' }, {
    effectiveAt: '2026-09-29T00:00:00Z', postings: [
      { account: 'asset', bucketId: 'shares', instrumentId: 'SHARE', quantity: '2' },
      { account: 'equity', instrumentId: 'SHARE', quantity: '-2' },
    ],
  }), /lot/);
  const opened = ledger.recordOperation({ kind: 'opening_position', occurredAt: '2026-09-29T00:00:00Z' }, {
    effectiveAt: '2026-09-29T00:00:00Z', postings: [
      { account: 'asset', bucketId: 'shares', instrumentId: 'SHARE', quantity: '2' },
      { account: 'equity', instrumentId: 'SHARE', quantity: '-2' },
    ],
    lotChanges: [{ kind: 'open', lotId: 'lot-1', bucketId: 'shares', instrumentId: 'SHARE', quantity: '2' }],
  });
  assert.equal(opened.entries.length, 1);
  assert.throws(() => ledger.recordOperation({ kind: 'sell', occurredAt: '2026-09-30T00:00:00Z' }, {
    effectiveAt: '2026-09-30T00:00:00Z', postings: [
      { account: 'asset', bucketId: 'shares', instrumentId: 'SHARE', quantity: '-3' },
      { account: 'trading', instrumentId: 'SHARE', quantity: '3' },
    ],
    lotChanges: [{ kind: 'dispose', lotId: 'lot-1', quantity: '3' }],
  }), /lot quantity/);
});

test('a transfer cannot mix different instruments in its transit postings', () => {
  const ledger = new Ledger('book', 'owner', () => '2026-10-01T00:00:00Z', () => 'currency');
  assert.throws(() => ledger.recordOperation({ kind: 'transfer', occurredAt: at, transfer: {
    sourceBucketId: 'source', destinationBucketId: 'target', instrumentId: 'USD', quantity: '5', fee: '0',
  } }, { effectiveAt: at, postings: [
    { account: 'asset', bucketId: 'source', instrumentId: 'USD', quantity: '-5' },
    { account: 'transit', instrumentId: 'USD', quantity: '5' },
    { account: 'asset', bucketId: 'source', instrumentId: 'EUR', quantity: '-1' },
    { account: 'transit', instrumentId: 'EUR', quantity: '1' },
  ] }), /transit instrument/);
});
