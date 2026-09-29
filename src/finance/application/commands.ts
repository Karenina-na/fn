import { Decimal } from '../decimal.ts';
import type { IdentityRegistry } from '../identity.ts';
import { Ledger, type LotChange, type Operation, type OperationInput, type OperationKind,
  type PostingInput, type TransferDetails } from '../ledger.ts';
import { StateProjection } from '../state.ts';

interface FactInput {
  effectiveAt: string; occurredAt?: string; source?: string; reference?: string;
  metadata?: Record<string, string>;
}
interface CashInput extends FactInput { bucketId: string; instrumentId: string; quantity: string }
interface TradeInput extends FactInput {
  cashBucketId: string; positionBucketId: string; instrumentId: string;
  quoteInstrumentId: string; quantity: string; unitPrice: string; fee?: string;
}

function positive(value: string, name: string): Decimal {
  const parsed = Decimal.parse(value);
  if (!parsed.isPositive()) throw new Error(`${name} must be positive`);
  return parsed;
}
function nonnegative(value: string, name: string): Decimal {
  const parsed = Decimal.parse(value);
  if (parsed.compare(Decimal.zero()) < 0) throw new Error(`${name} must be nonnegative`);
  return parsed;
}

export class FinanceCommands {
  private readonly state: StateProjection;
  constructor(private readonly identity: IdentityRegistry, private readonly ledger: Ledger) {
    this.state = new StateProjection(identity, ledger);
  }

  private currency(instrumentId: string): void {
    if (this.identity.getInstrument(instrumentId).kind !== 'currency') throw new Error('currency instrument is required');
  }
  private nonCurrency(instrumentId: string): void {
    if (this.identity.getInstrument(instrumentId).kind === 'currency') throw new Error('non-currency instrument is required');
  }
  private tradable(instrumentId: string): void {
    if (!['equity', 'etf', 'fund', 'crypto'].includes(this.identity.getInstrument(instrumentId).kind)) {
      throw new Error('instrument is not supported for trading');
    }
  }
  private bucket(bucketId: string): void { this.identity.getBucket(bucketId); }
  private record(kind: OperationKind, input: FactInput, postings: PostingInput[], lotChanges: LotChange[] = [], transfer?: TransferDetails): Operation {
    const operation: OperationInput = { kind, occurredAt: input.occurredAt ?? input.effectiveAt,
      source: input.source, reference: input.reference, metadata: input.metadata, transfer };
    return this.ledger.recordOperation(operation, { occurredAt: input.occurredAt,
      effectiveAt: input.effectiveAt, postings, lotChanges });
  }
  private validateContract(contractId: string | undefined, bucketId: string, instrumentId: string): void {
    if (!contractId) return;
    const contract = this.identity.getContract(contractId);
    if (contract.bucketId !== bucketId || contract.instrumentId !== instrumentId) throw new Error('contract does not match holding');
  }

  recordOpeningBalance(input: CashInput): Operation {
    this.bucket(input.bucketId);
    this.currency(input.instrumentId);
    const quantity = positive(input.quantity, 'opening quantity').toString();
    if (this.ledger.entries().some(entry => entry.postings.some(posting => posting.account === 'asset' &&
      posting.bucketId === input.bucketId && posting.instrumentId === input.instrumentId))) {
      throw new Error('holding already has financial history');
    }
    return this.record('opening_balance', input, [
      { account: 'asset', bucketId: input.bucketId, instrumentId: input.instrumentId, quantity },
      { account: 'equity', instrumentId: input.instrumentId, quantity: `-${quantity}` },
    ]);
  }

  recordOpeningPosition(input: FactInput & { bucketId: string; instrumentId: string; contractId?: string;
    quantity: string; acquiredAt?: string; cost?: { instrumentId: string; amount: string } }): Operation {
    this.bucket(input.bucketId);
    this.nonCurrency(input.instrumentId);
    this.validateContract(input.contractId, input.bucketId, input.instrumentId);
    const quantity = positive(input.quantity, 'opening quantity').toString();
    if (input.cost) { this.currency(input.cost.instrumentId); nonnegative(input.cost.amount, 'opening cost'); }
    if (this.ledger.entries().some(entry => entry.postings.some(posting => posting.account === 'asset' &&
      posting.bucketId === input.bucketId && posting.instrumentId === input.instrumentId && posting.contractId === input.contractId))) {
      throw new Error('holding already has financial history');
    }
    const lot: LotChange = { kind: 'open', lotId: this.ledger.allocateLotId(), bucketId: input.bucketId,
      instrumentId: input.instrumentId, contractId: input.contractId, acquiredAt: input.acquiredAt,
      quantity, cost: input.cost ? { instrumentId: input.cost.instrumentId, amount: Decimal.parse(input.cost.amount).toString() } : undefined };
    return this.record('opening_position', input, [
      { account: 'asset', bucketId: input.bucketId, instrumentId: input.instrumentId, contractId: input.contractId, quantity },
      { account: 'equity', instrumentId: input.instrumentId, quantity: `-${quantity}` },
    ], [lot]);
  }

  recordDeposit(input: CashInput): Operation {
    this.bucket(input.bucketId);
    this.currency(input.instrumentId);
    const quantity = positive(input.quantity, 'deposit quantity').toString();
    return this.record('deposit', input, [
      { account: 'asset', bucketId: input.bucketId, instrumentId: input.instrumentId, quantity },
      { account: 'external', instrumentId: input.instrumentId, quantity: `-${quantity}` },
    ]);
  }

  recordWithdrawal(input: CashInput): Operation {
    this.bucket(input.bucketId);
    this.currency(input.instrumentId);
    const quantity = positive(input.quantity, 'withdrawal quantity');
    return this.record('withdrawal', input, [
      { account: 'asset', bucketId: input.bucketId, instrumentId: input.instrumentId, quantity: quantity.negate().toString() },
      { account: 'external', instrumentId: input.instrumentId, quantity: quantity.toString() },
    ]);
  }

  recordBuy(input: TradeInput): Operation {
    this.bucket(input.cashBucketId);
    this.bucket(input.positionBucketId);
    this.tradable(input.instrumentId);
    this.currency(input.quoteInstrumentId);
    const quantity = positive(input.quantity, 'trade quantity');
    const price = positive(input.unitPrice, 'unit price');
    const fee = nonnegative(input.fee ?? '0', 'fee');
    const tradeAmount = quantity.multiply(price);
    const postings: PostingInput[] = [
      { account: 'asset', bucketId: input.positionBucketId, instrumentId: input.instrumentId, quantity: quantity.toString() },
      { account: 'trading', instrumentId: input.instrumentId, quantity: quantity.negate().toString() },
      { account: 'asset', bucketId: input.cashBucketId, instrumentId: input.quoteInstrumentId, quantity: tradeAmount.add(fee).negate().toString() },
      { account: 'trading', instrumentId: input.quoteInstrumentId, quantity: tradeAmount.toString() },
    ];
    if (!fee.isZero()) postings.push({ account: 'expense', instrumentId: input.quoteInstrumentId, quantity: fee.toString() });
    const lot: LotChange = { kind: 'open', lotId: this.ledger.allocateLotId(), bucketId: input.positionBucketId,
      instrumentId: input.instrumentId, acquiredAt: input.occurredAt ?? input.effectiveAt, quantity: quantity.toString(),
      cost: { instrumentId: input.quoteInstrumentId, amount: tradeAmount.toString() } };
    return this.record('buy', input, postings, [lot]);
  }

  recordSell(input: TradeInput): Operation {
    this.bucket(input.cashBucketId);
    this.bucket(input.positionBucketId);
    this.tradable(input.instrumentId);
    this.currency(input.quoteInstrumentId);
    const quantity = positive(input.quantity, 'trade quantity');
    const price = positive(input.unitPrice, 'unit price');
    const fee = nonnegative(input.fee ?? '0', 'fee');
    const proceeds = quantity.multiply(price);
    let remaining = quantity;
    const changes: LotChange[] = [];
    for (const lot of this.state.lots().filter(item => item.bucketId === input.positionBucketId &&
      item.instrumentId === input.instrumentId && item.contractId === undefined)) {
      if (remaining.isZero()) break;
      const available = Decimal.parse(lot.remainingQuantity);
      if (available.isZero()) continue;
      const taken = remaining.compare(available) < 0 ? remaining : available;
      changes.push({ kind: 'dispose', lotId: lot.id, quantity: taken.toString() });
      remaining = remaining.subtract(taken);
    }
    if (!remaining.isZero()) throw new Error('insufficient position quantity');
    const postings: PostingInput[] = [
      { account: 'asset', bucketId: input.positionBucketId, instrumentId: input.instrumentId, quantity: quantity.negate().toString() },
      { account: 'trading', instrumentId: input.instrumentId, quantity: quantity.toString() },
      { account: 'trading', instrumentId: input.quoteInstrumentId, quantity: proceeds.negate().toString() },
    ];
    if (!proceeds.subtract(fee).isZero()) postings.push({ account: 'asset', bucketId: input.cashBucketId,
      instrumentId: input.quoteInstrumentId, quantity: proceeds.subtract(fee).toString() });
    if (!fee.isZero()) postings.push({ account: 'expense', instrumentId: input.quoteInstrumentId, quantity: fee.toString() });
    return this.record('sell', input, postings, changes);
  }

  initiateTransfer(input: FactInput & { sourceBucketId: string; destinationBucketId: string;
    instrumentId: string; quantity: string; fee?: string }): Operation {
    this.bucket(input.sourceBucketId);
    this.bucket(input.destinationBucketId);
    if (input.sourceBucketId === input.destinationBucketId) throw new Error('transfer buckets must differ');
    this.currency(input.instrumentId);
    const quantity = positive(input.quantity, 'transfer quantity');
    const fee = nonnegative(input.fee ?? '0', 'fee');
    const postings: PostingInput[] = [
      { account: 'asset', bucketId: input.sourceBucketId, instrumentId: input.instrumentId, quantity: quantity.add(fee).negate().toString() },
      { account: 'transit', instrumentId: input.instrumentId, quantity: quantity.toString() },
    ];
    if (!fee.isZero()) postings.push({ account: 'expense', instrumentId: input.instrumentId, quantity: fee.toString() });
    return this.record('transfer', input, postings, [], {
      sourceBucketId: input.sourceBucketId, destinationBucketId: input.destinationBucketId,
      instrumentId: input.instrumentId, quantity: quantity.toString(), fee: fee.toString(),
    });
  }

  recordTransferReceipt(input: FactInput & { operationId: string; quantity?: string; fee?: string }): Operation {
    const operation = this.ledger.getOperation(input.operationId);
    if (operation.kind !== 'transfer' || !operation.transfer) throw new Error('transfer is not awaiting receipt');
    this.bucket(operation.transfer.destinationBucketId);
    const outstanding = this.state.inTransit().find(item => item.operationId === input.operationId);
    if (!outstanding) throw new Error('transfer is not awaiting receipt');
    const quantity = positive(input.quantity ?? outstanding.quantity, 'receipt quantity');
    if (quantity.compare(Decimal.parse(outstanding.quantity)) > 0) throw new Error('receipt exceeds amount in transit');
    const fee = nonnegative(input.fee ?? '0', 'receipt fee');
    const net = quantity.subtract(fee);
    const postings: PostingInput[] = [
      { account: 'transit', instrumentId: operation.transfer.instrumentId, quantity: quantity.negate().toString() },
    ];
    if (!net.isZero()) postings.push({ account: 'asset', bucketId: operation.transfer.destinationBucketId,
      instrumentId: operation.transfer.instrumentId, quantity: net.toString() });
    if (!fee.isZero()) postings.push({ account: 'expense', instrumentId: operation.transfer.instrumentId, quantity: fee.toString() });
    return this.ledger.appendEntry(input.operationId, { effectiveAt: input.effectiveAt,
      occurredAt: input.occurredAt, source: input.source, reference: input.reference,
      metadata: input.metadata, postings });
  }

  recordFxConversion(input: FactInput & { sourceBucketId: string; targetBucketId: string;
    sourceInstrumentId: string; targetInstrumentId: string; sourceQuantity: string;
    targetQuantity: string; fee?: string }): Operation {
    this.bucket(input.sourceBucketId);
    this.bucket(input.targetBucketId);
    this.currency(input.sourceInstrumentId);
    this.currency(input.targetInstrumentId);
    if (input.sourceInstrumentId === input.targetInstrumentId) throw new Error('conversion instruments must differ');
    const source = positive(input.sourceQuantity, 'source quantity');
    const target = positive(input.targetQuantity, 'target quantity');
    const fee = nonnegative(input.fee ?? '0', 'fee');
    const postings: PostingInput[] = [
      { account: 'asset', bucketId: input.sourceBucketId, instrumentId: input.sourceInstrumentId, quantity: source.add(fee).negate().toString() },
      { account: 'trading', instrumentId: input.sourceInstrumentId, quantity: source.toString() },
      { account: 'trading', instrumentId: input.targetInstrumentId, quantity: target.negate().toString() },
      { account: 'asset', bucketId: input.targetBucketId, instrumentId: input.targetInstrumentId, quantity: target.toString() },
    ];
    if (!fee.isZero()) postings.push({ account: 'expense', instrumentId: input.sourceInstrumentId, quantity: fee.toString() });
    return this.record('fx_conversion', input, postings);
  }
}
