import EntityController from '../controllers/EntityController.js';
import EntityService from '../services/EntityService.js';
import { EntityRepository } from '../repositories/EntityRepository.js';

export default async function (fastify) {
  const repository = new EntityRepository(fastify.db);
  const service = new EntityService({ entityRepository: repository });
  const controller = new EntityController({ entityService: service });

  fastify.get(
    '/apps/:appId/entities/:entityName',
    { preHandler: fastify.authenticate },
    controller.list.bind(controller)
  );

  fastify.get(
    '/apps/:appId/entities/:entityName/:id',
    { preHandler: fastify.authenticate },
    controller.get.bind(controller)
  );

  fastify.post(
    '/apps/:appId/entities/:entityName',
    { preHandler: fastify.authenticate },
    controller.create.bind(controller)
  );

  fastify.post(
    '/apps/:appId/master-contracts/upload',
    { preHandler: fastify.authenticate },
    controller.uploadMasterContracts.bind(controller)
  );

  fastify.post(
    '/apps/:appId/master-contracts/:contractId/approval',
    { preHandler: fastify.authenticate },
    controller.processMasterContractApproval.bind(controller)
  );

  fastify.post(
    '/apps/:appId/analytics/track/batch',
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      console.log('Analytics data received:', request.body);

      return reply.send({
        success: true,
        message: 'Analytics tracked'
      });
    }
  );

  fastify.put(
    '/apps/:appId/entities/:entityName/:id',
    { preHandler: fastify.authenticate },
    controller.update.bind(controller)
  );

  fastify.delete(
    '/apps/:appId/entities/:entityName/:id',
    { preHandler: fastify.authenticate },
    controller.delete.bind(controller)
  );
}
