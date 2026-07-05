import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { IncomingMessage } from 'http';
import { Server, WebSocket } from 'ws';
import { ALL, SubscriptionRegistry } from './subscription.registry';

interface InboundMessage {
  action?: unknown;
  matchId?: unknown;
}

/**
 * Raw-WebSocket fan-out (via NestJS WsAdapter / @nestjs/platform-ws).
 *
 * Outbound frames are sent as raw strings straight to `client.send()` — this is
 * what lets the ChaosEngine emit genuinely invalid-JSON malformed frames.
 * Inbound subscribe/unsubscribe is handled with our own per-socket `message`
 * listener rather than @SubscribeMessage, so clients speak plain JSON with no
 * framing envelope, and any garbage they send is ignored gracefully.
 */
@WebSocketGateway()
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger('EventsGateway');
  private readonly registry = new SubscriptionRegistry();

  @WebSocketServer()
  server!: Server;

  handleConnection(client: WebSocket, request: IncomingMessage): void {
    // Initial subscription from the query param; default is the firehose.
    const url = new URL(request.url ?? '/', 'http://localhost');
    const matchId = url.searchParams.get('matchId');
    if (matchId && matchId !== ALL) {
      this.registry.add(client, new Set([matchId]));
    } else {
      this.registry.add(client, ALL);
    }

    client.on('message', (raw: Buffer) => this.onMessage(client, raw));

    this.logger.log(`client connected → subscribed: ${this.registry.describe(client)}`);
    this.ack(client);
  }

  handleDisconnect(client: WebSocket): void {
    this.registry.remove(client);
    this.logger.log('client disconnected');
  }

  private onMessage(client: WebSocket, raw: Buffer): void {
    let msg: InboundMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // garbage inbound → ignore
    }
    if (!msg || typeof msg !== 'object') return;

    const { action, matchId } = msg;
    if (typeof action !== 'string' || typeof matchId !== 'string') return;

    if (action === 'subscribe') {
      this.registry.subscribe(client, matchId);
    } else if (action === 'unsubscribe') {
      this.registry.unsubscribe(client, matchId);
    } else {
      return; // unknown action → ignore
    }
    this.logger.log(`client ${action} ${matchId} → now: ${this.registry.describe(client)}`);
    this.ack(client);
  }

  private ack(client: WebSocket): void {
    this.safeSend(
      client,
      JSON.stringify({
        type: 'SUBSCRIPTION_ACK',
        subscribed: this.registry.describe(client),
      }),
    );
  }

  /** Send a raw frame to every client currently subscribed to `matchId`. */
  deliver(matchId: string, frame: string): void {
    for (const client of this.registry.clients()) {
      if (client.readyState === WebSocket.OPEN && this.registry.wants(client, matchId)) {
        this.safeSend(client, frame);
      }
    }
  }

  private safeSend(client: WebSocket, frame: string): void {
    try {
      client.send(frame);
    } catch (err) {
      this.logger.warn(`send failed: ${(err as Error).message}`);
    }
  }
}
