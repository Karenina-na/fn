import assert from 'node:assert/strict';
import test from 'node:test';
import { IdentityRegistry } from '../src/finance/identity.ts';

test('accounts contain buckets while cards and endpoints only bind to buckets', () => {
  const identity = new IdentityRegistry('book-1', 'owner-1');
  const wise = identity.registerInstitution({ name: 'Wise' });
  const account = identity.createAccount({ institutionId: wise.id, name: 'Wise', kind: 'payment' });
  const usd = identity.createBucket({ accountId: account.id, name: 'USD', kind: 'cash' });
  const eur = identity.createBucket({ accountId: account.id, name: 'EUR', kind: 'cash' });
  const card = identity.createCard({ accountId: account.id, formFactor: 'virtual', fundingType: 'debit', status: 'active' });
  const binding = identity.bindCard({ cardId: card.id, bucketId: usd.id });
  const endpoint = identity.createEndpoint({ kind: 'iban', maskedLabel: 'DE•••1234' });
  const endpointBinding = identity.bindEndpoint({ endpointId: endpoint.id, bucketId: eur.id });

  assert.equal(account.bookId, 'book-1');
  assert.equal(account.ownerId, 'owner-1');
  assert.equal(identity.getBucket(eur.id).accountId, account.id);
  assert.equal(identity.getCard(card.id).fundingType, 'debit');
  assert.equal(binding.bucketId, usd.id);
  assert.equal(endpointBinding.bucketId, eur.id);
  assert.equal(identity.listBuckets().length, 2);
});

test('instrument identity does not require a ticker and contracts identify distinct rights', () => {
  const identity = new IdentityRegistry('book-1', 'owner-1');
  const bank = identity.registerInstitution({ name: 'Bank' });
  const account = identity.createAccount({ institutionId: bank.id, name: 'Savings', kind: 'bank' });
  const bucket = identity.createBucket({ accountId: account.id, name: 'Deposits', kind: 'investment' });
  const deposit = identity.registerInstrument({ name: 'Fixed deposit product', kind: 'deposit' });
  const first = identity.registerContract({ accountId: account.id, bucketId: bucket.id, instrumentId: deposit.id, kind: 'fixed_deposit', termsReference: '2026-A' });
  const second = identity.registerContract({ accountId: account.id, bucketId: bucket.id, instrumentId: deposit.id, kind: 'fixed_deposit', termsReference: '2026-B' });
  assert.notEqual(first.id, second.id);
  assert.equal(identity.getInstrument(deposit.id).kind, 'deposit');
  assert.throws(() => identity.registerInstrument({ name: 'Invalid currency', kind: 'currency' }));
});

test('currency codes use one canonical identity per code', () => {
  const identity = new IdentityRegistry('book-1', 'owner-1');
  const usd = identity.registerInstrument({ name: 'US Dollar', kind: 'currency', code: 'usd' });
  assert.equal(usd.code, 'USD');
  assert.throws(() => identity.registerInstrument({ name: 'Dollar duplicate', kind: 'currency', code: 'USD' }), /already registered/);
});
