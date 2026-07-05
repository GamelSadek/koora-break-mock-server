/**
 * Minimal raw-WebSocket demo client.
 *
 * Its ONLY jobs: connect, subscribe to a match, print every frame, and flag seq
 * gaps / out-of-order / duplicate / malformed frames as it sees them. It does
 * NOT dedup, reorder-buffer, or heal gaps — that is the consumer backend's job,
 * built separately. This is purely to make the provider's behaviour visible.
 *
 * Usage:
 *   npm run demo                 # firehose (all matches)
 *   npm run demo -- match_003    # just one match (clearest for gap detection)
 *   PORT=3001 npm run demo -- match_003
 */
import { WebSocket } from 'ws';

const port = process.env.PORT ?? '3001';
const target = process.argv[2] ?? 'all';
const url = `ws://localhost:${port}/?matchId=${target}`;

const lastSeqByMatch = new Map<string, number>();

function log(line: string): void {
  // eslint-disable-next-line no-console
  console.log(line);
}

log(`connecting to ${url} ...`);
const ws = new WebSocket(url);

ws.on('open', () => {
  log(`connected. watching: ${target}`);
  log('legend:  ✓ ok   ↩ out-of-order   ⟳ dup duplicate   ⚠ gap   ✗ malformed\n');
});

ws.on('message', (raw: Buffer) => {
  const text = raw.toString();

  // 1) Parse — invalid JSON is a malformed frame (a lost event on the wire).
  let evt: Record<string, unknown>;
  try {
    evt = JSON.parse(text);
  } catch {
    log(`✗ malformed (invalid JSON): ${truncate(text)}`);
    return;
  }

  // Server ack for subscribe/unsubscribe.
  if (evt.type === 'SUBSCRIPTION_ACK') {
    log(`· ack — subscribed: ${String(evt.subscribed)}`);
    return;
  }

  // 2) Shape check — the consumer would reject these; here we just flag them.
  const seq = evt.seq;
  const matchId = evt.matchId;
  const type = evt.type;
  if (typeof seq !== 'number' || typeof matchId !== 'string' || typeof type !== 'string') {
    log(`✗ malformed (bad/missing fields): ${truncate(text)}`);
    return;
  }
  if (!KNOWN_TYPES.has(type)) {
    log(`✗ malformed (unknown type "${type}") seq=${seq} ${matchId}`);
    return;
  }

  // 3) Ordering diagnostics vs the last clean seq we saw for this match.
  const last = lastSeqByMatch.get(matchId);
  let marker = '✓';
  if (last !== undefined) {
    if (seq === last) marker = '⟳ dup';
    else if (seq < last) marker = '↩ out-of-order';
    else if (seq > last + 1) marker = `⚠ gap (expected ${last + 1}, got ${seq})`;
  }
  if (last === undefined || seq > last) lastSeqByMatch.set(matchId, seq);

  log(`${marker.padEnd(28)} seq=${String(seq).padStart(3)} ${matchId} ${type}${describe(evt)}`);
});

ws.on('close', () => log('\nconnection closed.'));
ws.on('error', (err) => log(`socket error: ${err.message}`));

const KNOWN_TYPES = new Set([
  'KICK_OFF', 'HALF_TIME', 'SECOND_HALF_KICK_OFF', 'FULL_TIME',
  'GOAL', 'YELLOW_CARD', 'RED_CARD', 'SUBSTITUTION', 'OFFSIDE',
  'GOAL_CANCELLED', 'RED_CARD_RESCINDED',
]);

function describe(evt: Record<string, unknown>): string {
  const bits: string[] = [];
  if (typeof evt.minute === 'number') bits.push(`${evt.minute}'`);
  if (typeof evt.team === 'string') bits.push(evt.team as string);
  if (typeof evt.player === 'string') bits.push(evt.player as string);
  if (typeof evt.refSeq === 'number') bits.push(`⟵ reverses seq=${evt.refSeq}`);
  if (typeof evt.reason === 'string') bits.push(`(${evt.reason})`);
  return bits.length ? `  ${bits.join(' · ')}` : '';
}

function truncate(s: string, n = 80): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
