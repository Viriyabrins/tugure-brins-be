import fp from 'fastify-plugin';
import { Pool } from 'pg';
import config from '../config/index.js';

export default fp(async (fastify) => {
  const pool = new Pool({ connectionString: config.databaseUrl });

  fastify.decorate('db', {
    query: (text, params) => pool.query(text, params),
    release: () => pool.end()
  });

  fastify.addHook('onClose', async () => {
    await pool.end();
  });
});
