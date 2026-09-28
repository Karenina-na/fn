export interface FinanceOverview {
  asOf: string;
  baseCurrency: string;
  totalValue: string;
}

export interface FinanceAccount {
  id: string;
  name: string;
  type: string;
  currency: string;
  balance: string;
  asOf: string;
}

export interface FinanceHolding {
  id: string;
  accountId: string;
  symbol: string;
  quantity: string;
  currency: string;
  marketValue: string;
  asOf: string;
}

export interface FinanceTransaction {
  id: string;
  accountId: string;
  occurredAt: string;
  type: string;
  amount: string;
  currency: string;
  description?: string;
}

export interface FinanceReader {
  getOverview(sessionId: string, signal?: AbortSignal): Promise<FinanceOverview>;
  listAccounts(sessionId: string, signal?: AbortSignal): Promise<FinanceAccount[]>;
  listHoldings(sessionId: string, filter: { accountId?: string }, signal?: AbortSignal): Promise<FinanceHolding[]>;
  listTransactions(sessionId: string, filter: { accountId?: string; from?: string; to?: string; limit: number }, signal?: AbortSignal): Promise<FinanceTransaction[]>;
}
