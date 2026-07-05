import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { ChaosConfigService } from '../chaos/chaos-config.service';
import { MatchSimulatorService } from '../simulator/match-simulator.service';

interface ChaosPatch {
  enabled?: boolean;
  dupRate?: number;
  reorderRate?: number;
  reorderMaxDelayMs?: number;
  malformedRate?: number;
  burstEnabled?: boolean;
}

/**
 * Control / observability endpoints — trigger bursts on demand and toggle chaos
 * modes (or the master switch) at runtime, without a restart.
 */
@Controller('control')
export class ControlController {
  constructor(
    private readonly simulator: MatchSimulatorService,
    private readonly chaos: ChaosConfigService,
  ) {}

  /** Trigger a derby burst on a specific match. Optional { size } in the body. */
  @Post('burst/:matchId')
  burst(
    @Param('matchId') matchId: string,
    @Body() body?: { size?: number },
  ): { matchId: string; triggered: boolean; events: number } {
    if (!this.simulator.hasMatch(matchId)) {
      throw new NotFoundException(`Unknown matchId: ${matchId}`);
    }
    const events = this.simulator.triggerBurst(matchId, body?.size);
    if (events === 0) {
      // Match exists but isn't live (already finished).
      return { matchId, triggered: false, events: 0 };
    }
    return { matchId, triggered: true, events };
  }

  /** Read the current chaos configuration. */
  @Get('chaos')
  getChaos(): Record<string, number | boolean> {
    return this.chaos.snapshot();
  }

  /**
   * Patch the chaos configuration at runtime. Body may contain any subset of:
   * { enabled, dupRate, reorderRate, reorderMaxDelayMs, malformedRate, burstEnabled }
   */
  @Post('chaos')
  setChaos(@Body() patch: ChaosPatch): Record<string, number | boolean> {
    if (!patch || typeof patch !== 'object') {
      throw new BadRequestException('Expected a JSON object body');
    }
    return this.chaos.update(patch);
  }
}
