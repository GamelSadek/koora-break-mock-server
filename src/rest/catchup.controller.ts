import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import { MatchSimulatorService } from '../simulator/match-simulator.service';
import { MatchEvent } from '../types/match-event';

/**
 * The provider's REST surface. Always serves CLEAN canonical data — chaos never
 * touches these responses. This is the consumer's source of truth for
 * reconnect / gap-healing / late-join.
 */
@Controller()
export class CatchupController {
  private readonly startedAt = Date.now();

  constructor(private readonly simulator: MatchSimulatorService) {}

  /** Basic health check. */
  @Get('health')
  health(): { status: string; matches: number; uptimeSeconds: number } {
    return {
      status: 'ok',
      matches: this.simulator.listMatches().length,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  /** Active matches with current sim-minute and seq high-water-mark. */
  @Get('matches')
  matches(@Query('includeFinished') includeFinished?: string) {
    const withFinished = includeFinished === 'true' || includeFinished === '1';
    return { matches: this.simulator.listMatches(withFinished) };
  }

  /**
   * Catch-up: all clean canonical events for a match with seq > `since`, in seq
   * order. `since` defaults to 0 (whole history). This is how a consumer heals a
   * detected seq gap or bootstraps current state on late-join.
   */
  @Get('matches/:matchId/events')
  events(
    @Param('matchId') matchId: string,
    @Query('since') since?: string,
  ): { matchId: string; since: number; count: number; events: MatchEvent[] } {
    if (!this.simulator.hasMatch(matchId)) {
      throw new NotFoundException(`Unknown matchId: ${matchId}`);
    }
    const sinceSeq = Number.isFinite(Number(since)) ? Number(since) : 0;
    const events = this.simulator.getEventsSince(matchId, sinceSeq);
    return { matchId, since: sinceSeq, count: events.length, events };
  }
}
