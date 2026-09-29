export type InstrumentKind = 'currency' | 'equity' | 'etf' | 'fund' | 'crypto' | 'deposit' | 'other';
export type AccountKind = 'bank' | 'broker' | 'payment' | 'exchange' | 'other';
export type BucketKind = 'cash' | 'investment' | 'spot' | 'funding' | 'other';

export interface Institution { id: string; name: string }
export interface Account {
  id: string; bookId: string; ownerId: string; institutionId: string;
  name: string; kind: AccountKind; status: 'active' | 'closed';
}
export interface Bucket { id: string; accountId: string; name: string; kind: BucketKind }
export interface FinancialInstrument {
  id: string; name: string; kind: InstrumentKind; code?: string;
  identifiers?: Record<string, string>;
}
export interface FinancialContract {
  id: string; accountId: string; bucketId: string; instrumentId: string;
  kind: string; termsReference?: string;
}
export interface Card {
  id: string; accountId: string; formFactor: 'physical' | 'virtual';
  fundingType: 'debit' | 'prepaid' | 'credit'; status: 'active' | 'inactive';
  network?: string; last4?: string;
}
export interface FundingBinding { id: string; cardId: string; bucketId: string }
export interface PaymentEndpoint {
  id: string; kind: 'iban' | 'local_bank_details' | 'fps_proxy' | 'crypto_address' | 'internal_id';
  namespace?: string; detailsRef?: string; maskedLabel?: string; servicingInstitutionId?: string;
}
export interface EndpointBinding { id: string; endpointId: string; bucketId: string }

function required(value: string, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function copy<T>(value: T): T { return structuredClone(value); }

export class IdentityRegistry {
  private sequence = 0;
  private institutions = new Map<string, Institution>();
  private accounts = new Map<string, Account>();
  private buckets = new Map<string, Bucket>();
  private instruments = new Map<string, FinancialInstrument>();
  private contracts = new Map<string, FinancialContract>();
  private cards = new Map<string, Card>();
  private fundingBindings = new Map<string, FundingBinding>();
  private endpoints = new Map<string, PaymentEndpoint>();
  private endpointBindings = new Map<string, EndpointBinding>();

  constructor(readonly bookId: string, readonly ownerId: string) {
    required(bookId, 'book id');
    required(ownerId, 'owner id');
  }

  private id(prefix: string): string { return `${prefix}_${++this.sequence}`; }
  private lookup<T>(map: Map<string, T>, id: string, name: string): T {
    const value = map.get(id);
    if (!value) throw new Error(`${name} not found: ${id}`);
    return copy(value);
  }

  registerInstitution(input: { name: string }): Institution {
    const value = { id: this.id('institution'), name: required(input.name, 'institution name') };
    this.institutions.set(value.id, value);
    return copy(value);
  }

  createAccount(input: { institutionId: string; name: string; kind: AccountKind }): Account {
    this.lookup(this.institutions, input.institutionId, 'institution');
    const value: Account = {
      id: this.id('account'), bookId: this.bookId, ownerId: this.ownerId,
      institutionId: input.institutionId, name: required(input.name, 'account name'),
      kind: input.kind, status: 'active',
    };
    this.accounts.set(value.id, value);
    return copy(value);
  }

  createBucket(input: { accountId: string; name: string; kind: BucketKind }): Bucket {
    const account = this.getAccount(input.accountId);
    if (account.status !== 'active') throw new Error('account is closed');
    const value: Bucket = { id: this.id('bucket'), accountId: account.id, name: required(input.name, 'bucket name'), kind: input.kind };
    this.buckets.set(value.id, value);
    return copy(value);
  }

  registerInstrument(input: Omit<FinancialInstrument, 'id'>): FinancialInstrument {
    const name = required(input.name, 'instrument name');
    const code = input.kind === 'currency' ? input.code?.trim().toUpperCase() : input.code?.trim();
    if (input.kind === 'currency' && !code) throw new Error('currency code is required');
    if (input.kind === 'currency' && !/^[A-Z]{3}$/.test(code!)) throw new Error('currency code must have three letters');
    if (input.kind === 'currency' && [...this.instruments.values()].some(item => item.kind === 'currency' && item.code === code)) {
      throw new Error('instrument code is already registered');
    }
    const value: FinancialInstrument = { ...copy(input), id: this.id('instrument'), name, code };
    this.instruments.set(value.id, value);
    return copy(value);
  }

  registerContract(input: Omit<FinancialContract, 'id'>): FinancialContract {
    const bucket = this.getBucket(input.bucketId);
    if (bucket.accountId !== input.accountId) throw new Error('contract bucket must belong to account');
    this.getInstrument(input.instrumentId);
    const value = { ...copy(input), id: this.id('contract'), kind: required(input.kind, 'contract kind') };
    this.contracts.set(value.id, value);
    return copy(value);
  }

  createCard(input: Omit<Card, 'id'>): Card {
    this.getAccount(input.accountId);
    if (input.last4 && !/^\d{4}$/.test(input.last4)) throw new Error('card last4 must contain four digits');
    const value = { ...copy(input), id: this.id('card') };
    this.cards.set(value.id, value);
    return copy(value);
  }

  bindCard(input: Omit<FundingBinding, 'id'>): FundingBinding {
    this.getCard(input.cardId);
    this.getBucket(input.bucketId);
    const value = { ...input, id: this.id('funding_binding') };
    this.fundingBindings.set(value.id, value);
    return copy(value);
  }

  createEndpoint(input: Omit<PaymentEndpoint, 'id'>): PaymentEndpoint {
    if (input.servicingInstitutionId) this.lookup(this.institutions, input.servicingInstitutionId, 'institution');
    const value = { ...copy(input), id: this.id('endpoint') };
    this.endpoints.set(value.id, value);
    return copy(value);
  }

  bindEndpoint(input: Omit<EndpointBinding, 'id'>): EndpointBinding {
    this.getEndpoint(input.endpointId);
    this.getBucket(input.bucketId);
    const value = { ...input, id: this.id('endpoint_binding') };
    this.endpointBindings.set(value.id, value);
    return copy(value);
  }

  getAccount(id: string): Account { return this.lookup(this.accounts, id, 'account'); }
  getBucket(id: string): Bucket { return this.lookup(this.buckets, id, 'bucket'); }
  getInstrument(id: string): FinancialInstrument { return this.lookup(this.instruments, id, 'instrument'); }
  getContract(id: string): FinancialContract { return this.lookup(this.contracts, id, 'contract'); }
  getCard(id: string): Card { return this.lookup(this.cards, id, 'card'); }
  getEndpoint(id: string): PaymentEndpoint { return this.lookup(this.endpoints, id, 'endpoint'); }
  listAccounts(): Account[] { return copy([...this.accounts.values()]); }
  listBuckets(): Bucket[] { return copy([...this.buckets.values()]); }
  listCards(): Card[] { return copy([...this.cards.values()]); }
  listEndpoints(): PaymentEndpoint[] { return copy([...this.endpoints.values()]); }
  listFundingBindings(): FundingBinding[] { return copy([...this.fundingBindings.values()]); }
  listEndpointBindings(): EndpointBinding[] { return copy([...this.endpointBindings.values()]); }
}
