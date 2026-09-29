import type { IdentityRegistry } from '../identity.ts';
import type { Ledger } from '../ledger.ts';
import { StateProjection } from '../state.ts';

export class FinanceQueries {
  private readonly state: StateProjection;
  constructor(private readonly identity: IdentityRegistry, private readonly ledger: Ledger) {
    this.state = new StateProjection(identity, ledger);
  }

  getAccount(id: string) {
    return { ...this.identity.getAccount(id), buckets: this.identity.listBuckets().filter(bucket => bucket.accountId === id) };
  }
  getBalances(filter: { bucketId?: string; asOf?: string } = {}) {
    return this.state.balances(filter.asOf).filter(balance => !filter.bucketId || balance.bucketId === filter.bucketId);
  }
  getPositions(filter: { bucketId?: string; asOf?: string } = {}) {
    return this.state.positions(filter.asOf).filter(position => !filter.bucketId || position.bucketId === filter.bucketId);
  }
  getLots(filter: { bucketId?: string; asOf?: string } = {}) {
    return this.state.lots(filter.asOf).filter(lot => !filter.bucketId || lot.bucketId === filter.bucketId);
  }
  getInTransit(asOf?: string) { return this.state.inTransit(asOf); }
  getAssetQuantities(asOf?: string) { return this.state.assetQuantities(asOf); }
  getOperations() { return this.ledger.listOperations(); }
  getJournalEntries(asOf?: string) { return this.ledger.entries(asOf); }
  getPortfolio(asOf?: string) {
    return { balances: this.state.balances(asOf), positions: this.state.positions(asOf),
      inTransit: this.state.inTransit(asOf), assetQuantities: this.state.assetQuantities(asOf) };
  }
}
