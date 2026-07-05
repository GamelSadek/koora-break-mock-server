import {
  CancelReason,
  InPlayEventType,
  MatchEvent,
  Team,
} from '../types/match-event';

export type MatchStatus = 'LIVE' | 'FINISHED';

/**
 * A single planned in-play event. Minutes and types are drawn at match creation
 * (the statistical "plan"); `seq`/`eventId`/`timestamp` are NOT decided here —
 * those are assigned at COMMIT time so seq reflects true commit order and
 * reversals can reference their target's real, already-committed eventId.
 */
export interface PlannedEvent {
  type: InPlayEventType;
  team: Team;
  player: string;
  minute: number;
  reason?: CancelReason;
  /** For reversals: the planned event this one reverses (GOAL / RED_CARD). */
  refPlan?: PlannedEvent;
  /** Filled in when this planned event is committed to the canonical log. */
  committed?: MatchEvent;
}

/** Live state for one simulated match. */
export interface MatchState {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  status: MatchStatus;
  /** Current simulated minute (0–90). */
  simMinute: number;
  /** Next seq to assign. Sole source of seq for BOTH tick and burst commits. */
  seqCounter: number;
  /** The canonical, clean, ordered, deduped event log — source of truth. */
  log: MatchEvent[];
  /** In-play plan grouped by minute. */
  planByMinute: Map<number, PlannedEvent[]>;
  /** Interval handle for this match's sim clock. */
  clock?: ReturnType<typeof setInterval>;
  /** Pending burst timers, tracked so they can be cleared on shutdown/finish. */
  burstTimers: Set<ReturnType<typeof setTimeout>>;
  createdAt: number;
}

// ── Flavour data ─────────────────────────────────────────────────────────────

const CLUBS = [
  'Al-Hilal', 'Al-Nassr', 'Al-Ittihad', 'Al-Ahli', 'Al-Shabab',
  'Al-Ettifaq', 'Al-Taawoun', 'Al-Fateh', 'Al-Feiha', 'Al-Raed',
  'Al-Wehda', 'Al-Khaleej', 'Damac', 'Abha', 'Al-Riyadh', 'Al-Okhdood',
];

const FIRST_NAMES = [
  'Mohammed', 'Salem', 'Abdullah', 'Salman', 'Fahad', 'Nawaf', 'Yasser',
  'Firas', 'Sami', 'Hassan', 'Saud', 'Ali', 'Turki', 'Ziyad', 'Khalid',
  'Nasser', 'Sultan', 'Riyad', 'Omar', 'Ahmed',
];

const LAST_NAMES = [
  'Al-Dawsari', 'Al-Shehri', 'Al-Buraikan', 'Al-Faraj', 'Al-Owais',
  'Al-Ghamdi', 'Al-Malki', 'Al-Amri', 'Al-Bishi', 'Al-Najei', 'Al-Harbi',
  'Al-Otaibi', 'Al-Qahtani', 'Al-Muwallad', 'Kanno', 'Al-Hamdan',
];

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomPlayer(): string {
  return `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
}

function randomTeam(): Team {
  return Math.random() < 0.5 ? 'home' : 'away';
}

/** Knuth's Poisson sampler — gives natural per-match variance around an average. */
function poisson(lambda: number): number {
  if (lambda <= 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= Math.random();
  } while (p > L);
  return k - 1;
}

/** Integer in [min, max] inclusive. */
function randInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

// Per-match averages (spec). Poisson draw around each => some 0–0, some wild.
const AVG = {
  OFFSIDE: 5,
  YELLOW_CARD: 3.5,
  GOAL: 2.7,
  RED_CARD: 0.25,
  SUBSTITUTION: 10,
};

const CANCEL_REASONS: readonly CancelReason[] = [
  'OFFSIDE', 'FOUL', 'HANDBALL', 'VAR_REVIEW',
];

/**
 * Build a match with a fully-scattered in-play plan. Reversals are scheduled
 * STRICTLY after the event they reference (correctness rule #1): if a valid
 * later minute (< 90) can't be found, the reversal is simply dropped rather
 * than placed early — an early reversal would fail its ref lookup at commit.
 */
export function createMatch(
  matchId: string,
  goalCancelProbability: number,
  redRescindProbability: number,
): MatchState {
  let homeTeam = pick(CLUBS);
  let awayTeam = pick(CLUBS);
  while (awayTeam === homeTeam) awayTeam = pick(CLUBS);

  const planned: PlannedEvent[] = [];

  // In-play minutes live in 1..89, avoiding the lifecycle boundaries (45/46).
  const inPlayMinute = (): number => {
    let m = randInt(1, 89);
    while (m === 45 || m === 46) m = randInt(1, 89);
    return m;
  };

  const addSimple = (type: InPlayEventType, count: number): PlannedEvent[] => {
    const made: PlannedEvent[] = [];
    for (let i = 0; i < count; i += 1) {
      const ev: PlannedEvent = {
        type,
        team: randomTeam(),
        player: randomPlayer(),
        minute: inPlayMinute(),
      };
      planned.push(ev);
      made.push(ev);
    }
    return made;
  };

  addSimple('OFFSIDE', poisson(AVG.OFFSIDE));
  addSimple('YELLOW_CARD', poisson(AVG.YELLOW_CARD));
  const goals = addSimple('GOAL', poisson(AVG.GOAL));
  const reds = addSimple('RED_CARD', poisson(AVG.RED_CARD));

  // Substitutions cluster in the 46'–89' window.
  const subCount = poisson(AVG.SUBSTITUTION);
  for (let i = 0; i < subCount; i += 1) {
    planned.push({
      type: 'SUBSTITUTION',
      team: randomTeam(),
      player: randomPlayer(),
      minute: randInt(46, 89),
    });
  }

  // Reversals: schedule strictly after the referenced event, else drop.
  const scheduleReversal = (
    target: PlannedEvent,
    type: InPlayEventType,
    reason?: CancelReason,
  ): void => {
    const earliest = target.minute + 1;
    if (earliest > 89) return; // no room for a strictly-later minute
    const minute = randInt(earliest, 89);
    planned.push({
      type,
      team: target.team, // reversal belongs to the same team as its target
      player: target.player,
      minute,
      reason,
      refPlan: target,
    });
  };

  for (const goal of goals) {
    if (Math.random() < goalCancelProbability) {
      scheduleReversal(goal, 'GOAL_CANCELLED', pick(CANCEL_REASONS));
    }
  }
  for (const red of reds) {
    if (Math.random() < redRescindProbability) {
      scheduleReversal(red, 'RED_CARD_RESCINDED');
    }
  }

  const planByMinute = new Map<number, PlannedEvent[]>();
  for (const ev of planned) {
    const bucket = planByMinute.get(ev.minute) ?? [];
    bucket.push(ev);
    planByMinute.set(ev.minute, bucket);
  }
  // Within a minute, keep targets before their reversals just in case a reversal
  // ever lands in the same bucket (it shouldn't — minute is strictly greater).
  for (const bucket of planByMinute.values()) {
    bucket.sort((a, b) => (a.refPlan ? 1 : 0) - (b.refPlan ? 1 : 0));
  }

  return {
    matchId,
    homeTeam,
    awayTeam,
    status: 'LIVE',
    simMinute: 0,
    seqCounter: 1,
    log: [],
    planByMinute,
    burstTimers: new Set(),
    createdAt: Date.now(),
  };
}

export { randInt, randomPlayer, randomTeam, pick };
