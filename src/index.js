import buildServer from './server.js';
import config from './config/index.js';

const start = async () => {
  const fastify = await buildServer();

  console.log('Backend env', {
    env: config.env,
    port: config.port,
    database: config.databaseUrl
  });

  await fastify.ready();
  console.log(fastify.printRoutes({ commonPrefix: true }));

  try {
    await fastify.listen({ port: config.port, host: '0.0.0.0' });
    fastify.log.info(`Server listening on ${config.port} in ${config.env}`);
  } catch (error) {
    fastify.log.error(error);
    process.exit(1);
  }
};

start();
