// One-off WebSocket smoke test (not part of the server). Run with:
//   node --import tsx src/scripts/wsSmoke.ts
// Connects to /ws, subscribes to "logs", inserts one synthetic EventLog row,
// and asserts the live poller broadcasts it back as a "created" event.
import { WebSocket } from 'ws';
import { prisma } from '@bptf/db';

const WS_URL = process.env.WS_URL ?? 'ws://127.0.0.1:3001/ws';

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
  const received: unknown[] = [];
  const ws = new WebSocket(WS_URL);

  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  out('connected, subscribing to logs');
  ws.on('message', (raw: Buffer) => received.push(JSON.parse(raw.toString())));
  ws.send(JSON.stringify({ topic: 'logs' }));

  await new Promise((r) => setTimeout(r, 500));
  const marker = `ws-smoke-${Date.now()}`;
  await prisma.eventLog.create({ data: { type: 'ws.smoke', level: 'info', message: marker } });
  out(`inserted EventLog ${marker}`);

  await new Promise((r) => setTimeout(r, 4000));
  ws.close();
  await prisma.$disconnect();

  out(`received messages: ${JSON.stringify(received)}`);
  const gotBroadcast = received.some(
    (m) => typeof m === 'object' && m !== null && (m as { event?: string }).event === 'created',
  );
  out(gotBroadcast ? 'PASS: live broadcast received' : 'FAIL: no broadcast');
  process.exit(gotBroadcast ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`${String(e)}\n`);
  process.exit(1);
});
