/**
 * Single shared source of truth for the event model.
 *
 * Two identifiers travel with every event and mean DIFFERENT things — this is
 * deliberate and load-bearing for the whole pipeline:
 *
 *   eventId  — a UUID v4. The IDENTITY of an event. A duplicate re-send carries
 *              the SAME eventId. This is the downstream dedup key.
 *   seq      — a per-match monotonic integer, starting at 1, +1 per committed
 *              event. The POSITION of an event in the true match history. This
 *              is the ordering / catch-up key. Chaos on the wire may reorder,
 *              duplicate, or corrupt frames, but `seq` is assigned once at
 *              commit time and is NEVER altered — so a consumer can always
 *              reconstruct true order and detect gaps.
 */

/** Match-status lifecycle events — exactly one of each per match, in order. */
export type LifecycleEventType =
  | 'KICK_OFF'
  | 'HALF_TIME'
  | 'SECOND_HALF_KICK_OFF'
  | 'FULL_TIME';

/** In-play events — the main flow (scoring, discipline) plus rare reversals. */
export type InPlayEventType =
  | 'GOAL'
  | 'YELLOW_CARD'
  | 'RED_CARD'
  | 'SUBSTITUTION'
  | 'OFFSIDE'
  | 'GOAL_CANCELLED'
  | 'RED_CARD_RESCINDED';

export type EventType = LifecycleEventType | InPlayEventType;

export const LIFECYCLE_EVENT_TYPES: readonly LifecycleEventType[] = [
  'KICK_OFF',
  'HALF_TIME',
  'SECOND_HALF_KICK_OFF',
  'FULL_TIME',
];

export function isLifecycleType(type: EventType): type is LifecycleEventType {
  return (LIFECYCLE_EVENT_TYPES as readonly string[]).includes(type);
}

export type Team = 'home' | 'away';

/** Reason a goal was cancelled — present ONLY on GOAL_CANCELLED. */
export type CancelReason = 'OFFSIDE' | 'FOUL' | 'HANDBALL' | 'VAR_REVIEW';

/**
 * The canonical event shape. Match-status events omit `team`/`player`.
 * Reversal events (GOAL_CANCELLED, RED_CARD_RESCINDED) additionally carry the
 * `refEventId`/`refSeq` of the REAL prior event they reverse.
 */
export interface MatchEvent {
  /** UUID v4 — unique identity per event; duplicates reuse it. */
  eventId: string;
  /** e.g. "match_001". */
  matchId: string;
  /** Per-match monotonic sequence, starts at 1. Order/catch-up key. */
  seq: number;
  type: EventType;
  /** Present for in-play events; omitted for match-status events. */
  team?: Team;
  /** Sim-clock minute the event occurred at (0–90). */
  minute: number;
  /** Present for in-play events; omitted for match-status events. */
  player?: string;
  /** ISO 8601. */
  timestamp: string;

  // ── Reversal-only fields ───────────────────────────────────────────────────
  /** eventId of the real prior event being reversed. */
  refEventId?: string;
  /** seq of that prior event (readable logs/debugging). */
  refSeq?: number;
  /** GOAL_CANCELLED only. */
  reason?: CancelReason;
}
