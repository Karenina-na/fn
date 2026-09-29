import { Decimal } from './decimal.ts';
import type { IdentityRegistry } from './identity.ts';
import type { Ledger, Operation } from './ledger.ts';

export interface Balance { bucketId: string; instrumentId: string; quantity: string }
export interface ExactCost { instrumentId: string; numerator: string; denominator: string }
export interface Position {
  bucketId: string; instrumentId: string; contractId?: string; quantity: string;
  costBasisStatus: 'known' | 'unknown'; costBasis: ExactCost[] | null;
}
export interface Lot {
  id: string; bucketId: string; instrumentId: string; contractId?: string;
  acquiredAt: string | null; originalQuantity: string; remainingQuantity: string;
  costAmount: { instrumentId: string; amount: string } | null; sourceOperationId: string;
}
export interface InTransit {
  operationId: string; sourceBucketId: string; destinationBucketId: string;
  instrumentId: string; quantity: string;
}
export interface AssetQuantity { instrumentId: string; quantity: string }

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  while (b !== 0n) [a, b] = [b, a % b];
  return a || 1n;
}

class Fraction {
  private constructor(readonly numerator: bigint, readonly denominator: bigint) {}
  static zero(): Fraction { return new Fraction(0n, 1n); }
  static of(numerator: bigint, denominator: bigint): Fraction {
    if (denominator <= 0n) throw new Error('cost denominator must be positive');
    const divisor = gcd(numerator, denominator);
    return new Fraction(numerator / divisor, denominator / divisor);
  }
  static remainingCost(cost: string, remaining: string, original: string): Fraction {
    const c = Decimal.parse(cost);
    const r = Decimal.parse(remaining);
    const o = Decimal.parse(original);
    return Fraction.of(c.coefficient * r.coefficient * 10n ** BigInt(o.scale),
      o.coefficient * 10n ** BigInt(c.scale + r.scale));
  }
  add(other: Fraction): Fraction {
    return Fraction.of(this.numerator * other.denominator + other.numerator * this.denominator,
      this.denominator * other.denominator);
  }
  toCost(instrumentId: string): ExactCost {
    return { instrumentId, numerator: this.numerator.toString(), denominator: this.denominator.toString() };
  }
}

interface State { holdings: Map<string, { bucketId: string; instrumentId: string; contractId?: string; quantity: Decimal }>; lots: Map<string, Lot>; transit: Map<string, Decimal> }
function holdingKey(bucketId: string, instrumentId: string, contractId?: string): string { return JSON.stringify([bucketId, instrumentId, contractId ?? null]); }

export class StateProjection {
  constructor(private readonly identity: IdentityRegistry, private readonly ledger: Ledger) {}

  private build(asOf?: string): State {
    const holdings: State['holdings'] = new Map();
    const lots: State['lots'] = new Map();
    const transit: State['transit'] = new Map();
    const operations = new Map(this.ledger.listOperations().map(operation => [operation.id, operation]));
    for (const entry of this.ledger.entries(asOf)) {
      const operation = operations.get(entry.operationId)!;
      for (const posting of entry.postings) {
        const quantity = Decimal.parse(posting.quantity);
        if (posting.account === 'asset') {
          const key = holdingKey(posting.bucketId!, posting.instrumentId, posting.contractId);
          const previous = holdings.get(key);
          holdings.set(key, { bucketId: posting.bucketId!, instrumentId: posting.instrumentId, contractId: posting.contractId,
            quantity: (previous?.quantity ?? Decimal.zero()).add(quantity) });
        }
        if (posting.account === 'transit') transit.set(operation.id, (transit.get(operation.id) ?? Decimal.zero()).add(quantity));
      }
      for (const change of entry.lotChanges) {
        if (change.kind === 'open') {
          if (lots.has(change.lotId)) throw new Error('duplicate lot');
          lots.set(change.lotId, {
            id: change.lotId, bucketId: change.bucketId, instrumentId: change.instrumentId,
            contractId: change.contractId, acquiredAt: change.acquiredAt ?? null,
            originalQuantity: change.quantity, remainingQuantity: change.quantity,
            costAmount: change.cost ?? null, sourceOperationId: operation.id,
          });
        } else {
          const lot = lots.get(change.lotId);
          if (!lot) throw new Error('lot not found');
          const remaining = Decimal.parse(lot.remainingQuantity).subtract(Decimal.parse(change.quantity));
          if (remaining.compare(Decimal.zero()) < 0) throw new Error('lot quantity exceeded');
          lot.remainingQuantity = remaining.toString();
        }
      }
    }
    return { holdings, lots, transit };
  }

  balances(asOf?: string): Balance[] {
    return [...this.build(asOf).holdings.values()]
      .filter(item => this.identity.getInstrument(item.instrumentId).kind === 'currency' && !item.quantity.isZero())
      .map(item => ({ bucketId: item.bucketId, instrumentId: item.instrumentId, quantity: item.quantity.toString() }));
  }

  positions(asOf?: string): Position[] {
    const state = this.build(asOf);
    return [...state.holdings.values()].filter(item => this.identity.getInstrument(item.instrumentId).kind !== 'currency' && !item.quantity.isZero())
      .map(item => {
        const relevant = [...state.lots.values()].filter(lot =>
          lot.bucketId === item.bucketId && lot.instrumentId === item.instrumentId && lot.contractId === item.contractId && Decimal.parse(lot.remainingQuantity).isPositive());
        const lotQuantity = relevant.reduce((sum, lot) => sum.add(Decimal.parse(lot.remainingQuantity)), Decimal.zero());
        if (lotQuantity.compare(item.quantity) !== 0) throw new Error('position and lot quantities differ');
        const known = relevant.every(lot => lot.costAmount !== null);
        const costs = new Map<string, Fraction>();
        if (known) for (const lot of relevant) {
          const cost = lot.costAmount!;
          costs.set(cost.instrumentId, (costs.get(cost.instrumentId) ?? Fraction.zero()).add(
            Fraction.remainingCost(cost.amount, lot.remainingQuantity, lot.originalQuantity)));
        }
        return {
          bucketId: item.bucketId, instrumentId: item.instrumentId, contractId: item.contractId,
          quantity: item.quantity.toString(), costBasisStatus: known ? 'known' as const : 'unknown' as const,
          costBasis: known ? [...costs].map(([instrumentId, fraction]) => fraction.toCost(instrumentId)) : null,
        };
      });
  }

  lots(asOf?: string): Lot[] { return structuredClone([...this.build(asOf).lots.values()]); }

  inTransit(asOf?: string): InTransit[] {
    const state = this.build(asOf);
    const operations = this.ledger.listOperations();
    return [...state.transit].filter(([, quantity]) => !quantity.isZero()).map(([operationId, quantity]) => {
      const operation: Operation = operations.find(item => item.id === operationId)!;
      if (!operation.transfer) throw new Error('transit posting requires a transfer operation');
      return { operationId, sourceBucketId: operation.transfer.sourceBucketId,
        destinationBucketId: operation.transfer.destinationBucketId,
        instrumentId: operation.transfer.instrumentId, quantity: quantity.toString() };
    });
  }

  assetQuantities(asOf?: string): AssetQuantity[] {
    const state = this.build(asOf);
    const totals = new Map<string, Decimal>();
    for (const item of state.holdings.values()) totals.set(item.instrumentId, (totals.get(item.instrumentId) ?? Decimal.zero()).add(item.quantity));
    for (const transit of this.inTransit(asOf)) totals.set(transit.instrumentId,
      (totals.get(transit.instrumentId) ?? Decimal.zero()).add(Decimal.parse(transit.quantity)));
    return [...totals].filter(([, quantity]) => !quantity.isZero())
      .map(([instrumentId, quantity]) => ({ instrumentId, quantity: quantity.toString() }));
  }
}
