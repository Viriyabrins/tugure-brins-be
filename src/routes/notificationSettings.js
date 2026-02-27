import NotificationSettingController from '../controllers/NotificationSettingController.js';
import NotificationSettingService from '../services/NotificationSettingService.js';
import { NotificationSettingRepository } from '../repositories/NotificationSettingRepository.js';

export default async function (fastify) {
  const repository = new NotificationSettingRepository();
  const service = new NotificationSettingService({ notificationSettingRepository: repository });
  const controller = new NotificationSettingController({ notificationSettingService: service });

  const guard = { preHandler: fastify.authenticate };

  // GET /api/notification-settings/me?keycloak_user_id=<sub>
  fastify.get('/notification-settings/me', guard, controller.getMySettings.bind(controller));

  // PUT /api/notification-settings/me  (body includes keycloak_user_id)
  fastify.put('/notification-settings/me', guard, controller.upsertMySettings.bind(controller));
}
