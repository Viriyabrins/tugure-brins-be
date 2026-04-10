import '../config/index.js';
import { Client } from 'pg';
import eventBus from '../utils/eventBus.js';

let client = null;
const channelTables = new Set((process.env.DB_CHANNEL_TABLES || 'debtor,mastercontract')
  .split(',')
  .map((table) => table.trim())
  .filter(Boolean));

export async function startDBChannel() {
  if (client) {
    return client;
  }

  client = new Client({ connectionString: process.env.DATABASE_URL });

  client.on('notification', (msg) => {
    const payload = JSON.parse(msg.payload);

    if (channelTables.has(payload.table)) {
      eventBus.emit('db-channel', {
        ...payload,
        receivedAt: new Date().toISOString()
      });
      // handle entity-specific logic
    }
    console.log("Debtorssssssss",payload);
  });

  client.on('error', (error) => {
    console.error('[DBChannel] listener error:', error);
  });

  await client.connect();
  await client.query('LISTEN shared_channel');

  console.log('[DBChannel] listening on shared_channel');
  return client;
}

export async function stopDBChannel() {
  if (!client) {
    return;
  }

  await client.end();
  client = null;
}
