import fp from 'fastify-plugin';
import fastifyMultipart from '@fastify/multipart';

/**
 * Register multipart form-data handler for file uploads.
 * Wrapped with fastify-plugin so the content-type parser is
 * available to every route (not encapsulated).
 */
export default fp(async (fastify, opts) => {
  await fastify.register(fastifyMultipart, {
    limits: {
      fileSize: 50 * 1024 * 1024, // 50MB max file size
      files: 10, // Max files per request
      fields: 10, // Max fields per request
    },
  });
});
