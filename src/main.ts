import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // Raw `ws` transport — plain JSON text frames, and the only way to emit
  // genuinely invalid-JSON malformed frames. Not socket.io.
  app.useWebSocketAdapter(new WsAdapter(app));

  const config = app.get(ConfigService);
  const port = config.get<number>('port')!;

  await app.listen(port);

  const logger = new Logger('Bootstrap');
  logger.log(`Mock StatsPerform server listening on :${port}`);
  logger.log(`  REST  →  http://localhost:${port}/matches`);
  logger.log(`  WS    →  ws://localhost:${port}/?matchId=all  (firehose)`);
}

void bootstrap();
