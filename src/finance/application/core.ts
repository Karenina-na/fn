import { IdentityRegistry } from '../identity.ts';
import { Ledger } from '../ledger.ts';
import { FinanceCommands } from './commands.ts';
import { FinanceQueries } from './queries.ts';

export class FinanceCore {
  readonly identity: IdentityRegistry;
  readonly command: FinanceCommands;
  readonly query: FinanceQueries;

  constructor(config: { bookId: string; ownerId: string; now?: () => string }) {
    this.identity = new IdentityRegistry(config.bookId, config.ownerId);
    const ledger = new Ledger(config.bookId, config.ownerId, config.now, id => this.identity.getInstrument(id).kind);
    this.command = new FinanceCommands(this.identity, ledger);
    this.query = new FinanceQueries(this.identity, ledger);
  }
}
