import assert from 'node:assert/strict';
import test from 'node:test';
import { FinanceCore } from '../src/finance/application/core.ts';

const at = '2026-09-29T00:00:00Z';
const later = '2026-09-30T00:00:00Z';
const core = () => new FinanceCore({ bookId: 'book', ownerId: 'owner', now: () => '2026-10-10T00:00:00Z' });

function setupAccount(finance: FinanceCore, name: string, kind: 'bank' | 'broker' | 'payment' = 'bank') {
  const institution = finance.identity.registerInstitution({ name });
  const account = finance.identity.createAccount({ institutionId: institution.id, name, kind });
  const bucket = finance.identity.createBucket({ accountId: account.id, name: 'Cash', kind: 'cash' });
  return { account, bucket };
}

test('IBKR opening cash and NVDA buy derive cash, position and cost', () => {
  const finance = core();
  const { account, bucket: cash } = setupAccount(finance, 'IBKR', 'broker');
  const securities = finance.identity.createBucket({ accountId: account.id, name: 'Securities', kind: 'investment' });
  const usd = finance.identity.registerInstrument({ name: 'US Dollar', kind: 'currency', code: 'USD' });
  const nvda = finance.identity.registerInstrument({ name: 'NVIDIA shares', kind: 'equity', identifiers: { ticker: 'NVDA' } });
  finance.command.recordOpeningBalance({ bucketId: cash.id, instrumentId: usd.id, quantity: '20000', effectiveAt: at });
  finance.command.recordBuy({ cashBucketId: cash.id, positionBucketId: securities.id,
    instrumentId: nvda.id, quoteInstrumentId: usd.id, quantity: '50', unitPrice: '180',
    occurredAt: at, effectiveAt: later });
  assert.equal(finance.query.getBalances()[0]?.quantity, '11000');
  assert.equal(finance.query.getPositions()[0]?.quantity, '50');
  assert.deepEqual(finance.query.getPositions()[0]?.costBasis, [{ instrumentId: usd.id, numerator: '9000', denominator: '1' }]);
  assert.equal(finance.query.getLots()[0]?.sourceOperationId, finance.query.getOperations()[1]?.id);
  assert.equal(finance.query.getLots()[0]?.acquiredAt, at);
  assert.equal(finance.query.getBalances({ asOf: at })[0]?.quantity, '20000');
});

test('transfer debits source, counts transit once, records fee and later receipt', () => {
  const finance = core();
  const hsbc = setupAccount(finance, 'HSBC');
  const wise = setupAccount(finance, 'Wise', 'payment');
  const usd = finance.identity.registerInstrument({ name: 'US Dollar', kind: 'currency', code: 'USD' });
  finance.command.recordOpeningBalance({ bucketId: hsbc.bucket.id, instrumentId: usd.id, quantity: '10000', effectiveAt: at });
  const transfer = finance.command.initiateTransfer({ sourceBucketId: hsbc.bucket.id, destinationBucketId: wise.bucket.id,
    instrumentId: usd.id, quantity: '5000', fee: '10', effectiveAt: later });
  assert.equal(finance.query.getBalances({ bucketId: hsbc.bucket.id })[0]?.quantity, '4990');
  assert.deepEqual(finance.query.getBalances({ bucketId: wise.bucket.id }), []);
  assert.equal(finance.query.getInTransit()[0]?.quantity, '5000');
  assert.equal(finance.query.getAssetQuantities()[0]?.quantity, '9990');
  assert.ok(transfer.entries[0]?.postings.some(posting => posting.account === 'expense' && posting.quantity === '10'));
  finance.command.recordTransferReceipt({ operationId: transfer.id, effectiveAt: '2026-10-01T00:00:00Z',
    source: 'wise-statement', reference: 'receipt-1' });
  assert.equal(finance.query.getBalances({ bucketId: wise.bucket.id })[0]?.quantity, '5000');
  assert.deepEqual(finance.query.getInTransit(), []);
  assert.equal(finance.query.getAssetQuantities()[0]?.quantity, '9990');
  assert.equal(finance.query.getOperations().find(operation => operation.id === transfer.id)?.entries.length, 2);
  assert.equal(finance.query.getOperations().find(operation => operation.id === transfer.id)?.entries[1]?.reference, 'receipt-1');
  assert.throws(() => finance.command.recordTransferReceipt({ operationId: transfer.id, effectiveAt: '2026-10-02T00:00:00Z' }));
});

test('card and payment endpoint bindings do not duplicate Wise assets', () => {
  const finance = core();
  const wise = setupAccount(finance, 'Wise', 'payment');
  const eur = finance.identity.registerInstrument({ name: 'Euro', kind: 'currency', code: 'EUR' });
  const eurBucket = finance.identity.createBucket({ accountId: wise.account.id, name: 'EUR', kind: 'cash' });
  finance.command.recordOpeningBalance({ bucketId: eurBucket.id, instrumentId: eur.id, quantity: '800', effectiveAt: at });
  const card = finance.identity.createCard({ accountId: wise.account.id, formFactor: 'virtual', fundingType: 'debit', status: 'active' });
  finance.identity.bindCard({ cardId: card.id, bucketId: eurBucket.id });
  const endpoint = finance.identity.createEndpoint({ kind: 'iban', maskedLabel: 'DE•••1234' });
  finance.identity.bindEndpoint({ endpointId: endpoint.id, bucketId: eurBucket.id });
  assert.deepEqual(finance.query.getAssetQuantities(), [{ instrumentId: eur.id, quantity: '800' }]);
  assert.equal(finance.query.getPortfolio().balances.length, 1);
});

test('opening position can retain unknown cost without inventing a buy', () => {
  const finance = core();
  const broker = setupAccount(finance, 'Broker', 'broker');
  const shares = finance.identity.createBucket({ accountId: broker.account.id, name: 'Shares', kind: 'investment' });
  const aapl = finance.identity.registerInstrument({ name: 'Apple shares', kind: 'equity' });
  finance.command.recordOpeningPosition({ bucketId: shares.id, instrumentId: aapl.id, quantity: '100', effectiveAt: at });
  assert.equal(finance.query.getPositions()[0]?.quantity, '100');
  assert.equal(finance.query.getPositions()[0]?.costBasisStatus, 'unknown');
  assert.equal(finance.query.getPositions()[0]?.costBasis, null);
  assert.deepEqual(finance.query.getOperations().map(operation => operation.kind), ['opening_position']);
});

test('FX conversion records both asset units and a separate fee without cross-currency netting', () => {
  const finance = core();
  const wise = setupAccount(finance, 'Wise', 'payment');
  const eurBucket = finance.identity.createBucket({ accountId: wise.account.id, name: 'EUR', kind: 'cash' });
  const usd = finance.identity.registerInstrument({ name: 'USD', kind: 'currency', code: 'USD' });
  const eur = finance.identity.registerInstrument({ name: 'EUR', kind: 'currency', code: 'EUR' });
  finance.command.recordOpeningBalance({ bucketId: wise.bucket.id, instrumentId: usd.id, quantity: '1002', effectiveAt: at });
  const fx = finance.command.recordFxConversion({ sourceBucketId: wise.bucket.id, targetBucketId: eurBucket.id,
    sourceInstrumentId: usd.id, targetInstrumentId: eur.id, sourceQuantity: '1000', targetQuantity: '920', fee: '2', effectiveAt: later });
  assert.deepEqual(finance.query.getBalances(), [{ bucketId: eurBucket.id, instrumentId: eur.id, quantity: '920' }]);
  assert.deepEqual(finance.query.getAssetQuantities(), [{ instrumentId: eur.id, quantity: '920' }]);
  assert.equal(fx.kind, 'fx_conversion');
  assert.equal(fx.entries[0]?.postings.filter(posting => posting.account === 'trading').length, 2);
  assert.ok(fx.entries[0]?.postings.some(posting => posting.account === 'expense' && posting.instrumentId === usd.id && posting.quantity === '2'));
});

test('deposits, withdrawals and FIFO sale preserve lots', () => {
  const finance = core();
  const broker = setupAccount(finance, 'Broker', 'broker');
  const shares = finance.identity.createBucket({ accountId: broker.account.id, name: 'Shares', kind: 'investment' });
  const usd = finance.identity.registerInstrument({ name: 'USD', kind: 'currency', code: 'USD' });
  const nvda = finance.identity.registerInstrument({ name: 'NVDA', kind: 'equity' });
  finance.command.recordOpeningBalance({ bucketId: broker.bucket.id, instrumentId: usd.id, quantity: '1000', effectiveAt: at });
  finance.command.recordDeposit({ bucketId: broker.bucket.id, instrumentId: usd.id, quantity: '200', effectiveAt: later, source: 'statement', reference: 'deposit-1' });
  assert.throws(() => finance.command.recordDeposit({ bucketId: broker.bucket.id, instrumentId: usd.id, quantity: '200', effectiveAt: later, source: 'statement', reference: 'deposit-1' }), /already recorded/);
  finance.command.recordWithdrawal({ bucketId: broker.bucket.id, instrumentId: usd.id, quantity: '50', effectiveAt: later });
  finance.command.recordBuy({ cashBucketId: broker.bucket.id, positionBucketId: shares.id, instrumentId: nvda.id,
    quoteInstrumentId: usd.id, quantity: '2', unitPrice: '100', effectiveAt: later });
  finance.command.recordSell({ cashBucketId: broker.bucket.id, positionBucketId: shares.id, instrumentId: nvda.id,
    quoteInstrumentId: usd.id, quantity: '1', unitPrice: '150', fee: '1', effectiveAt: later });
  assert.equal(finance.query.getBalances()[0]?.quantity, '1099');
  assert.equal(finance.query.getPositions()[0]?.quantity, '1');
  assert.deepEqual(finance.query.getPositions()[0]?.costBasis, [{ instrumentId: usd.id, numerator: '100', denominator: '1' }]);
  assert.throws(() => finance.command.recordSell({ cashBucketId: broker.bucket.id, positionBucketId: shares.id,
    instrumentId: nvda.id, quoteInstrumentId: usd.id, quantity: '2', unitPrice: '150', effectiveAt: later }), /insufficient/);
});

test('accepted cash facts are recorded even when earlier history is incomplete', () => {
  const finance = core();
  const bank = setupAccount(finance, 'Bank');
  const usd = finance.identity.registerInstrument({ name: 'USD', kind: 'currency', code: 'USD' });
  finance.command.recordWithdrawal({ bucketId: bank.bucket.id, instrumentId: usd.id,
    quantity: '5', effectiveAt: at, source: 'statement', reference: 'withdrawal-1' });
  assert.equal(finance.query.getBalances()[0]?.quantity, '-5');
  assert.equal(finance.query.getOperations()[0]?.source, 'statement');
});

test('a sale cannot consume a lot attached to a distinct contract', () => {
  const finance = core();
  const broker = setupAccount(finance, 'Broker', 'broker');
  const shares = finance.identity.createBucket({ accountId: broker.account.id, name: 'Shares', kind: 'investment' });
  const usd = finance.identity.registerInstrument({ name: 'USD', kind: 'currency', code: 'USD' });
  const asset = finance.identity.registerInstrument({ name: 'Restricted shares', kind: 'equity' });
  const contract = finance.identity.registerContract({ accountId: broker.account.id, bucketId: shares.id,
    instrumentId: asset.id, kind: 'restricted' });
  finance.command.recordOpeningPosition({ bucketId: shares.id, instrumentId: asset.id, contractId: contract.id,
    quantity: '10', effectiveAt: at });
  assert.throws(() => finance.command.recordSell({ cashBucketId: broker.bucket.id, positionBucketId: shares.id,
    instrumentId: asset.id, quoteInstrumentId: usd.id, quantity: '1', unitPrice: '5', effectiveAt: later }), /insufficient/);
  assert.equal(finance.query.getPositions()[0]?.quantity, '10');
});

test('a sale fee equal to proceeds leaves zero cash credit and keeps the entry balanced', () => {
  const finance = core();
  const broker = setupAccount(finance, 'Broker', 'broker');
  const shares = finance.identity.createBucket({ accountId: broker.account.id, name: 'Shares', kind: 'investment' });
  const usd = finance.identity.registerInstrument({ name: 'USD', kind: 'currency', code: 'USD' });
  const asset = finance.identity.registerInstrument({ name: 'Share', kind: 'equity' });
  finance.command.recordOpeningBalance({ bucketId: broker.bucket.id, instrumentId: usd.id, quantity: '1', effectiveAt: at });
  finance.command.recordBuy({ cashBucketId: broker.bucket.id, positionBucketId: shares.id,
    instrumentId: asset.id, quoteInstrumentId: usd.id, quantity: '1', unitPrice: '1', effectiveAt: later });
  const sale = finance.command.recordSell({ cashBucketId: broker.bucket.id, positionBucketId: shares.id,
    instrumentId: asset.id, quoteInstrumentId: usd.id, quantity: '1', unitPrice: '1', fee: '1', effectiveAt: later });
  assert.equal(sale.entries[0]?.postings.some(posting => posting.account === 'asset' && posting.instrumentId === usd.id), false);
  assert.deepEqual(finance.query.getBalances(), []);
});

test('partial sale retains an exact fractional cost basis', () => {
  const finance = core();
  const broker = setupAccount(finance, 'Broker', 'broker');
  const shares = finance.identity.createBucket({ accountId: broker.account.id, name: 'Shares', kind: 'investment' });
  const usd = finance.identity.registerInstrument({ name: 'USD', kind: 'currency', code: 'USD' });
  const asset = finance.identity.registerInstrument({ name: 'Share', kind: 'equity' });
  finance.command.recordOpeningPosition({ bucketId: shares.id, instrumentId: asset.id,
    quantity: '3', cost: { instrumentId: usd.id, amount: '10' }, effectiveAt: at });
  finance.command.recordSell({ cashBucketId: broker.bucket.id, positionBucketId: shares.id,
    instrumentId: asset.id, quoteInstrumentId: usd.id, quantity: '1', unitPrice: '5', effectiveAt: later });
  assert.deepEqual(finance.query.getPositions()[0]?.costBasis, [{ instrumentId: usd.id, numerator: '20', denominator: '3' }]);
});

test('partial transfer receipts keep the remaining right in transit and record destination fees', () => {
  const finance = core();
  const source = setupAccount(finance, 'Source');
  const target = setupAccount(finance, 'Target');
  const usd = finance.identity.registerInstrument({ name: 'USD', kind: 'currency', code: 'USD' });
  finance.command.recordOpeningBalance({ bucketId: source.bucket.id, instrumentId: usd.id, quantity: '1000', effectiveAt: at });
  const transfer = finance.command.initiateTransfer({ sourceBucketId: source.bucket.id, destinationBucketId: target.bucket.id,
    instrumentId: usd.id, quantity: '500', fee: '10', effectiveAt: later });
  const first = finance.command.recordTransferReceipt({ operationId: transfer.id, quantity: '300', fee: '5',
    occurredAt: '2026-09-30T12:00:00Z', effectiveAt: '2026-10-01T00:00:00Z' });
  assert.equal(first.entries.length, 2);
  assert.equal(first.entries[1]?.occurredAt, '2026-09-30T12:00:00Z');
  assert.equal(finance.query.getBalances({ bucketId: target.bucket.id })[0]?.quantity, '295');
  assert.equal(finance.query.getInTransit()[0]?.quantity, '200');
  assert.equal(finance.query.getAssetQuantities()[0]?.quantity, '985');
  finance.command.recordTransferReceipt({ operationId: transfer.id, quantity: '200', effectiveAt: '2026-10-02T00:00:00Z' });
  assert.equal(finance.query.getBalances({ bucketId: target.bucket.id })[0]?.quantity, '495');
  assert.deepEqual(finance.query.getInTransit(), []);
  assert.equal(finance.query.getAssetQuantities()[0]?.quantity, '985');
  assert.throws(() => finance.command.recordTransferReceipt({ operationId: transfer.id, quantity: '1',
    effectiveAt: '2026-10-03T00:00:00Z' }), /awaiting receipt/);
});

test('receipt evidence cannot be accepted for two transfers', () => {
  const finance = core();
  const source = setupAccount(finance, 'Source');
  const target = setupAccount(finance, 'Target');
  const usd = finance.identity.registerInstrument({ name: 'USD', kind: 'currency', code: 'USD' });
  finance.command.recordOpeningBalance({ bucketId: source.bucket.id, instrumentId: usd.id, quantity: '1000', effectiveAt: at });
  const first = finance.command.initiateTransfer({ sourceBucketId: source.bucket.id, destinationBucketId: target.bucket.id,
    instrumentId: usd.id, quantity: '100', effectiveAt: later });
  const second = finance.command.initiateTransfer({ sourceBucketId: source.bucket.id, destinationBucketId: target.bucket.id,
    instrumentId: usd.id, quantity: '100', effectiveAt: later });
  finance.command.recordTransferReceipt({ operationId: first.id, effectiveAt: later,
    source: 'statement', reference: 'receipt-1' });
  assert.throws(() => finance.command.recordTransferReceipt({ operationId: second.id, effectiveAt: later,
    source: 'statement', reference: 'receipt-1' }), /already recorded/);
  assert.equal(finance.query.getInTransit()[0]?.operationId, second.id);
});

test('opening lot retains an original acquisition date or explicitly unknown date', () => {
  const finance = core();
  const broker = setupAccount(finance, 'Broker', 'broker');
  const shares = finance.identity.createBucket({ accountId: broker.account.id, name: 'Shares', kind: 'investment' });
  const aapl = finance.identity.registerInstrument({ name: 'AAPL', kind: 'equity' });
  const nvda = finance.identity.registerInstrument({ name: 'NVDA', kind: 'equity' });
  finance.command.recordOpeningPosition({ bucketId: shares.id, instrumentId: aapl.id,
    quantity: '10', acquiredAt: '2020-01-01T00:00:00Z', effectiveAt: at });
  finance.command.recordOpeningPosition({ bucketId: shares.id, instrumentId: nvda.id, quantity: '10', effectiveAt: at });
  assert.equal(finance.query.getLots().find(lot => lot.instrumentId === aapl.id)?.acquiredAt, '2020-01-01T00:00:00Z');
  assert.equal(finance.query.getLots().find(lot => lot.instrumentId === nvda.id)?.acquiredAt, null);
});

test('a real sale can have fees greater than proceeds', () => {
  const finance = core();
  const broker = setupAccount(finance, 'Broker', 'broker');
  const shares = finance.identity.createBucket({ accountId: broker.account.id, name: 'Shares', kind: 'investment' });
  const usd = finance.identity.registerInstrument({ name: 'USD', kind: 'currency', code: 'USD' });
  const equity = finance.identity.registerInstrument({ name: 'Share', kind: 'equity' });
  finance.command.recordOpeningPosition({ bucketId: shares.id, instrumentId: equity.id, quantity: '1', effectiveAt: at });
  finance.command.recordSell({ cashBucketId: broker.bucket.id, positionBucketId: shares.id,
    instrumentId: equity.id, quoteInstrumentId: usd.id, quantity: '1', unitPrice: '1', fee: '2', effectiveAt: later });
  assert.equal(finance.query.getBalances()[0]?.quantity, '-1');
  assert.equal(finance.query.getJournalEntries()[1]?.postings.find(posting => posting.account === 'expense')?.quantity, '2');
});
