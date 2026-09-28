import { z } from 'zod';
import type { Tool } from '../../tool/tool.ts';
import type { FinanceReader } from './domain.ts';

const empty = z.strictObject({});
const holdings = z.strictObject({ accountId: z.string().min(1).optional() });
const transactions = z.strictObject({
  accountId: z.string().min(1).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export function financeTools(finance: FinanceReader): Tool<any>[] {
  return [
    {
      name: 'finance_overview', description: 'Get the current portfolio value and valuation time.',
      usage: 'Use for total assets or overall portfolio value. Report the supplied valuation timestamp and currency.',
      effect: 'read_only', schema: empty,
      execute: (_, context) => finance.getOverview(context.sessionId, context.signal),
    },
    {
      name: 'finance_accounts', description: 'List current accounts and their balances.',
      usage: 'Use for account balances and account inventory. Keep each returned currency distinct.',
      effect: 'read_only', schema: empty,
      execute: (_, context) => finance.listAccounts(context.sessionId, context.signal),
    },
    {
      name: 'finance_holdings', description: 'List positions and their market values, optionally for one account.',
      usage: 'Use for positions, allocations, and exposure. Treat market values as of their supplied timestamps.',
      effect: 'read_only', schema: holdings,
      execute: (input, context) => finance.listHoldings(context.sessionId, input, context.signal),
    },
    {
      name: 'finance_transactions', description: 'List transaction records with optional account and date filters.',
      usage: 'Use for transaction history and cash flows. An empty or bounded result does not prove older transactions do not exist.',
      effect: 'read_only', schema: transactions,
      execute: (input, context) => finance.listTransactions(context.sessionId, { ...input, limit: input.limit ?? 20 }, context.signal),
    },
  ];
}
