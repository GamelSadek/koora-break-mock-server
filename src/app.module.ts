import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { ChaosConfigService } from './chaos/chaos-config.service';
import { ChaosEngineService } from './chaos/chaos-engine.service';
import { EventsGateway } from './gateway/events.gateway';
import { CatchupController } from './rest/catchup.controller';
import { ControlController } from './rest/control.controller';
import { MatchSimulatorService } from './simulator/match-simulator.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
  ],
  controllers: [CatchupController, ControlController],
  providers: [
    MatchSimulatorService,
    ChaosConfigService,
    EventsGateway,
    ChaosEngineService,
  ],
})
export class AppModule {}
