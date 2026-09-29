import assert from 'node:assert/strict';
import test from 'node:test';
import { IdentityRegistry } from '../src/finance/identity.ts';
import { Ledger } from '../src/finance/ledger.ts';
import { StateProjection } from '../src/finance/state.ts';

test('state is rebuilt from ledger entries and preserves lot cost through partial disposal', () => {
  const identity = new IdentityRegistry('book', 'owner');
  const institution = identity.registerInstitution({ name: 'Broker' });
  const account = identity.createAccount({ institutionId: institution.id, name: 'Broker', kind: 'broker' });
  const bucket = identity.createBucket({ accountId: account.id, name: 'Securities', kind: 'investment' });
  const usd = identity.registerInstrument({ name: 'USD', kind: 'currency', code: 'USD' });
  const equity = identity.registerInstrument({ name: 'Equity', kind: 'equity' });
  const ledger = new Ledger('book', 'owner', () => '2026-10-01T12:00:00Z', id => identity.getInstrument(id).kind);
  const opening = ledger.recordOperation({ kind: 'opening_position', occurredAt: '2026-09-29T00:00:00Z' }, {
    effectiveAt: '2026-09-29T00:00:00Z',
    postings: [
      { account: 'asset', bucketId: bucket.id, instrumentId: equity.id, quantity: '100' },
      { account: 'equity', instrumentId: equity.id, quantity: '-100' },
    ],
    lotChanges: [{ kind: 'open', lotId: 'lot-1', bucketId: bucket.id, instrumentId: equity.id,
      acquiredAt: '2026-09-29T00:00:00Z', quantity: '100', cost: { instrumentId: usd.id, amount: '600' } }],
  });
  ledger.recordOperation({ kind: 'sell', occurredAt: '2026-09-30T00:00:00Z' }, {
    effectiveAt: '2026-09-30T00:00:00Z',
    postings: [
      { account: 'asset', bucketId: bucket.id, instrumentId: equity.id, quantity: '-25' },
      { account: 'trading', instrumentId: equity.id, quantity: '25' },
    ],
    lotChanges: [{ kind: 'dispose', lotId: 'lot-1', quantity: '25' }],
  });
  const state = new StateProjection(identity, ledger);
  assert.equal(state.positions()[0]?.quantity, '75');
  assert.deepEqual(state.positions()[0]?.costBasis, [{ instrumentId: usd.id, numerator: '450', denominator: '1' }]);
  assert.equal(state.positions('2026-09-29T23:59:59Z')[0]?.quantity, '100');
  assert.equal(state.lots()[0]?.sourceOperationId, opening.id);
  assert.equal(state.lots()[0]?.remainingQuantity, '75');
});

test('unknown opening cost remains unknown in derived positions', () => {
  const identity = new IdentityRegistry('book', 'owner');
  const institution = identity.registerInstitution({ name: 'Broker' });
  const account = identity.createAccount({ institutionId: institution.id, name: 'Broker', kind: 'broker' });
  const bucket = identity.createBucket({ accountId: account.id, name: 'Securities', kind: 'investment' });
  const equity = identity.registerInstrument({ name: 'AAPL', kind: 'equity' });
  const ledger = new Ledger('book', 'owner', () => '2026-10-01T12:00:00Z', id => identity.getInstrument(id).kind);
  ledger.recordOperation({ kind: 'opening_position', occurredAt: '2026-09-29T00:00:00Z' }, {
    effectiveAt: '2026-09-29T00:00:00Z',
    postings: [
      { account: 'asset', bucketId: bucket.id, instrumentId: equity.id, quantity: '100' },
      { account: 'equity', instrumentId: equity.id, quantity: '-100' },
    ],
    lotChanges: [{ kind: 'open', lotId: 'lot-1', bucketId: bucket.id, instrumentId: equity.id,
      acquiredAt: '2026-09-29T00:00:00Z', quantity: '100' }],
  });
  const position = new StateProjection(identity, ledger).positions()[0];
  assert.equal(position?.quantity, '100');
  assert.equal(position?.costBasisStatus, 'unknown');
  assert.equal(position?.costBasis, null);
});
