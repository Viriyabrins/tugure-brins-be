import NotificationController from '../controllers/NotificationController.js';
import NotificationService from '../services/NotificationService.js';
import { NotificationRepository } from '../repositories/NotificationRepository.js';
import NotificationFlow from '../flows/NotificationFlow.js';

export default async function (fastify) {
  const repository = new NotificationRepository(fastify.db);
  const service = new NotificationService({ notificationRepository: repository });
  const flow = new NotificationFlow({ notificationService: service });
  const controller = new NotificationController({ notificationService: service, notificationFlow: flow });

  const guard = { preHandler: fastify.authenticate };

  fastify.get('/notifications', guard, controller.list.bind(controller));
  fastify.post('/notifications', guard, controller.create.bind(controller));
  fastify.put('/notifications/:id/read', guard, controller.markAsRead.bind(controller));
  fastify.put('/notifications/:id', guard, controller.update.bind(controller));
  fastify.delete('/notifications/:id', guard, controller.delete.bind(controller));
}
