import { WebSocket } from 'ws';

/** Sentinel meaning "firehose" — receive every match's events. */
export const ALL = 'all' as const;

/**
 * Tracks what each connected socket is subscribed to.
 *
 * A client is either on the firehose (ALL) or subscribed to an explicit set of
 * matchIds. Semantics (also documented in the README):
 *   - subscribe(client, "match_003")  → ADD match_003 to the client's set
 *   - subscribe(client, "all")        → switch to firehose (overrides the set)
 *   - unsubscribe(client, "match_003") → remove match_003
 *   - unsubscribe(client, "all")      → clear firehose → receives nothing
 */
export class SubscriptionRegistry {
  /** value is either the ALL sentinel or a Set of specific matchIds. */
  private readonly subs = new Map<WebSocket, typeof ALL | Set<string>>();

  add(client: WebSocket, initial: typeof ALL | Set<string>): void {
    this.subs.set(client, initial);
  }

  remove(client: WebSocket): void {
    this.subs.delete(client);
  }

  subscribe(client: WebSocket, matchId: string): void {
    if (matchId === ALL) {
      this.subs.set(client, ALL);
      return;
    }
    const current = this.subs.get(client);
    if (current === ALL || current === undefined) {
      // Coming from firehose (or fresh) to a specific match starts a new set.
      this.subs.set(client, new Set([matchId]));
      return;
    }
    current.add(matchId);
  }

  unsubscribe(client: WebSocket, matchId: string): void {
    if (matchId === ALL) {
      this.subs.set(client, new Set()); // firehose off → nothing
      return;
    }
    const current = this.subs.get(client);
    if (current && current !== ALL) current.delete(matchId);
  }

  /** Does this client currently want events for `matchId`? */
  wants(client: WebSocket, matchId: string): boolean {
    const current = this.subs.get(client);
    if (current === undefined) return false;
    if (current === ALL) return true;
    return current.has(matchId);
  }

  clients(): IterableIterator<WebSocket> {
    return this.subs.keys();
  }

  describe(client: WebSocket): string {
    const current = this.subs.get(client);
    if (current === ALL) return 'all';
    if (!current || current.size === 0) return '(none)';
    return [...current].join(',');
  }
}
