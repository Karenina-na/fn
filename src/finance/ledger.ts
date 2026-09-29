import { Decimal } from './decimal.ts';
import type { InstrumentKind } from './identity.ts';

export type OperationKind =
  | 'opening_balance' | 'opening_position' | 'deposit' | 'withdrawal'
  | 'buy' | 'sell' | 'transfer' | 'fx_conversion';
export type LedgerAccount = 'asset' | 'transit' | 'expense' | 'equity' | 'external' | 'trading';
export interface PostingInput { account: LedgerAccount; bucketId?: string; contractId?: string; instrumentId: string; quantity: string }
export interface Posting extends PostingInput { id: string }
export type LotChange =
  | { kind: 'open'; lotId: string; bucketId: string; instrumentId: string; contractId?: string; acquiredAt?: string; quantity: string; cost?: { instrumentId: string; amount: string } }
  | { kind: 'dispose'; lotId: string; quantity: string };
export interface JournalEntry {
  id: string; operationId: string; occurredAt: string; effectiveAt: string; recordedAt: string;
  source?: string; reference?: string; metadata?: Record<string, string>;
  postings: Posting[]; lotChanges: LotChange[];
}
export interface TransferDetails {
  sourceBucketId: string; destinationBucketId: string; instrumentId: string;
  quantity: string; fee: string;
}
export interface Operation {
  id: string; bookId: string; ownerId: string; kind: OperationKind; occurredAt: string; createdAt: string;
  source?: string; reference?: string; metadata?: Record<string, string>;
  reversesOperationId?: string; transfer?: TransferDetails; entries: JournalEntry[];
}
export type OperationInput = Omit<Operation, 'id' | 'bookId' | 'ownerId' | 'createdAt' | 'entries'>;
export interface EntryDraft {
  occurredAt?: string; effectiveAt: string; source?: string; reference?: string; metadata?: Record<string, string>;
  postings: PostingInput[]; lotChanges?: LotChange[];
}

export function validateTime(value: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`invalid timestamp: ${value}`);
  }
  if (new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== value.slice(0, 10)) {
    throw new Error(`invalid timestamp: ${value}`);
  }
  return value;
}

export function validatePostings(postings: PostingInput[]): void {
  if (postings.length < 2) throw new Error('journal entry requires at least two postings');
  const totals = new Map<string, Decimal>();
  for (const posting of postings) {
    if (!posting.instrumentId?.trim()) throw new Error('posting instrument is required');
    if ((posting.account === 'asset') && !posting.bucketId?.trim()) throw new Error('asset posting bucket is required');
    if (posting.account !== 'asset' && posting.bucketId) throw new Error('non-asset posting cannot name a bucket');
    if (posting.account !== 'asset' && posting.contractId) throw new Error('non-asset posting cannot name a contract');
    const quantity = Decimal.parse(posting.quantity);
    if (quantity.isZero()) throw new Error('zero posting is not allowed');
    totals.set(posting.instrumentId, (totals.get(posting.instrumentId) ?? Decimal.zero()).add(quantity));
  }
  for (const [instrumentId, total] of totals) {
    if (!total.isZero()) throw new Error(`unbalanced journal entry for ${instrumentId}`);
  }
}

export class Ledger {
  private sequence = 0;
  private operations: Operation[] = [];
  constructor(readonly bookId: string, readonly ownerId: string,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly instrumentKind: (instrumentId: string) => InstrumentKind) {
    if (!bookId.trim() || !ownerId.trim()) throw new Error('book and owner ids are required');
  }

  allocateLotId(): string { return `lot_${++this.sequence}`; }

  recordOperation(input: OperationInput, draft: EntryDraft): Operation {
    const createdAt = validateTime(this.now());
    this.validateDraft(draft, createdAt);
    validateTime(input.occurredAt);
    if (Date.parse(input.occurredAt) > Date.parse(createdAt)) throw new Error('future event cannot be recorded');
    if (input.kind === 'transfer' && !input.transfer) throw new Error('transfer details are required');
    if (input.kind !== 'transfer' && input.transfer) throw new Error('transfer details require a transfer operation');
    if (input.transfer) {
      const transit = draft.postings.filter(posting => posting.account === 'transit');
      if (transit.some(posting => posting.instrumentId !== input.transfer!.instrumentId)) throw new Error('transit instrument differs from transfer');
      const amount = transit.reduce((sum, posting) => sum.add(Decimal.parse(posting.quantity)), Decimal.zero());
      if (amount.compare(Decimal.parse(input.transfer.quantity)) !== 0) throw new Error('transfer transit quantity differs from operation');
    }
    this.validateReference(input.source, input.reference);
    const id = `operation_${++this.sequence}`;
    const entry = this.makeEntry(id, { source: input.source, reference: input.reference,
      metadata: input.metadata, occurredAt: input.occurredAt, ...draft }, createdAt);
    const operation: Operation = { ...structuredClone(input), id, bookId: this.bookId, ownerId: this.ownerId, createdAt, entries: [entry] };
    this.operations.push(operation);
    return structuredClone(operation);
  }

  appendEntry(operationId: string, draft: EntryDraft): Operation {
    const index = this.operations.findIndex(operation => operation.id === operationId);
    if (index < 0) throw new Error('operation not found');
    const recordedAt = validateTime(this.now());
    this.validateDraft(draft, recordedAt, true);
    this.validateReference(draft.source, draft.reference);
    const operation = this.operations[index]!;
    if (operation.kind !== 'transfer' || !operation.transfer) throw new Error('operation cannot receive another entry');
    if (Date.parse(draft.effectiveAt) < Date.parse(operation.entries[0]!.effectiveAt)) throw new Error('receipt predates transfer debit');
    if (draft.postings.some(posting => posting.account === 'transit' && posting.instrumentId !== operation.transfer!.instrumentId)) {
      throw new Error('transit instrument differs from transfer');
    }
    const outstanding = operation.entries.flatMap(item => item.postings).filter(posting => posting.account === 'transit')
      .reduce((sum, posting) => sum.add(Decimal.parse(posting.quantity)), Decimal.zero());
    const debit = draft.postings.filter(posting => posting.account === 'transit' && posting.instrumentId === operation.transfer!.instrumentId)
      .reduce((sum, posting) => sum.add(Decimal.parse(posting.quantity)), Decimal.zero());
    if (!outstanding.isPositive() || debit.compare(Decimal.zero()) >= 0 ||
      debit.negate().compare(outstanding) > 0) throw new Error('operation cannot receive another entry');
    const entry = this.makeEntry(operationId, draft, recordedAt);
    const updated = { ...operation, entries: [...operation.entries, entry] };
    this.operations[index] = updated;
    return structuredClone(updated);
  }

  listOperations(): Operation[] { return structuredClone(this.operations); }
  getOperation(id: string): Operation {
    const operation = this.operations.find(item => item.id === id);
    if (!operation) throw new Error('operation not found');
    return structuredClone(operation);
  }
  entries(asOf?: string): JournalEntry[] {
    if (asOf) validateTime(asOf);
    const cutoff = asOf ? Date.parse(asOf) : Infinity;
    return structuredClone(this.operations.flatMap(operation => operation.entries)
      .filter(entry => Date.parse(entry.effectiveAt) <= cutoff)
      .sort((a, b) => Date.parse(a.effectiveAt) - Date.parse(b.effectiveAt) ||
        Number(a.id.slice('entry_'.length)) - Number(b.id.slice('entry_'.length))));
  }

  private validateReference(source?: string, reference?: string): void {
    if (source && reference && this.operations.some(operation => operation.entries.some(entry =>
      entry.source === source && entry.reference === reference))) throw new Error('source reference is already recorded');
  }

  private validateDraft(draft: EntryDraft, recordedAt: string, allowBackdated = false): void {
    validateTime(draft.effectiveAt);
    validateTime(draft.occurredAt ?? draft.effectiveAt);
    if (Date.parse(draft.effectiveAt) > Date.parse(recordedAt) ||
      Date.parse(draft.occurredAt ?? draft.effectiveAt) > Date.parse(recordedAt)) throw new Error('future event cannot be recorded');
    const latest = this.entries().at(-1)?.effectiveAt;
    if (!allowBackdated && latest && Date.parse(draft.effectiveAt) < Date.parse(latest)) throw new Error('backdated posting requires reconciliation');
    validatePostings(draft.postings);
    this.validateLots(draft);
  }

  private validateLots(draft: EntryDraft): void {
    const assetChanges = new Map<string, Decimal>();
    const lotChanges = new Map<string, Decimal>();
    const key = (bucketId: string, instrumentId: string, contractId?: string) =>
      JSON.stringify([bucketId, instrumentId, contractId ?? null]);
    const add = (map: Map<string, Decimal>, holding: string, quantity: Decimal) =>
      map.set(holding, (map.get(holding) ?? Decimal.zero()).add(quantity));
    for (const posting of draft.postings) {
      const kind = this.instrumentKind(posting.instrumentId);
      if (posting.account === 'asset' && kind !== 'currency') {
        add(assetChanges, key(posting.bucketId!, posting.instrumentId, posting.contractId), Decimal.parse(posting.quantity));
      }
    }
    const history = this.operations.flatMap(operation => operation.entries.flatMap(entry => entry.lotChanges));
    const opened = new Map<string, Extract<LotChange, { kind: 'open' }>>();
    const remaining = new Map<string, Decimal>();
    for (const change of history) {
      if (change.kind === 'open') {
        opened.set(change.lotId, change);
        remaining.set(change.lotId, Decimal.parse(change.quantity));
      } else {
        remaining.set(change.lotId, (remaining.get(change.lotId) ?? Decimal.zero()).subtract(Decimal.parse(change.quantity)));
      }
    }
    for (const change of draft.lotChanges ?? []) {
      if (change.kind === 'open') {
        if (!change.lotId.trim() || opened.has(change.lotId)) throw new Error('duplicate or missing lot id');
        if (this.instrumentKind(change.instrumentId) === 'currency') throw new Error('currency does not use position lots');
        const quantity = Decimal.parse(change.quantity);
        if (!quantity.isPositive()) throw new Error('lot quantity must be positive');
        if (change.acquiredAt) {
          validateTime(change.acquiredAt);
          if (Date.parse(change.acquiredAt) > Date.parse(draft.effectiveAt)) throw new Error('lot acquisition follows holding');
        }
        if (change.cost) {
          if (this.instrumentKind(change.cost.instrumentId) !== 'currency' ||
            Decimal.parse(change.cost.amount).compare(Decimal.zero()) < 0) throw new Error('invalid lot cost');
        }
        opened.set(change.lotId, change);
        remaining.set(change.lotId, quantity);
        add(lotChanges, key(change.bucketId, change.instrumentId, change.contractId), quantity);
      } else {
        const lot = opened.get(change.lotId);
        if (!lot) throw new Error('lot not found');
        const quantity = Decimal.parse(change.quantity);
        if (!quantity.isPositive() || quantity.compare(remaining.get(change.lotId)!) > 0) throw new Error('lot quantity exceeded');
        remaining.set(change.lotId, remaining.get(change.lotId)!.subtract(quantity));
        add(lotChanges, key(lot.bucketId, lot.instrumentId, lot.contractId), quantity.negate());
      }
    }
    for (const holding of new Set([...assetChanges.keys(), ...lotChanges.keys()])) {
      if ((assetChanges.get(holding) ?? Decimal.zero()).compare(lotChanges.get(holding) ?? Decimal.zero()) !== 0) {
        throw new Error('asset and lot quantities differ');
      }
    }
  }

  private makeEntry(operationId: string, draft: EntryDraft, recordedAt: string): JournalEntry {
    return {
      id: `entry_${++this.sequence}`, operationId, occurredAt: draft.occurredAt ?? draft.effectiveAt,
      effectiveAt: draft.effectiveAt, recordedAt,
      source: draft.source, reference: draft.reference, metadata: draft.metadata ? structuredClone(draft.metadata) : undefined,
      postings: draft.postings.map(posting => ({ ...posting, id: `posting_${++this.sequence}`, quantity: Decimal.parse(posting.quantity).toString() })),
      lotChanges: structuredClone(draft.lotChanges ?? []),
    };
  }
}
