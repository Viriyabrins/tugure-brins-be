import AppController from '../controllers/AppController.js';
import AppService from '../services/AppService.js';
import config from '../config/index.js';

export default async function (fastify) {
  const appService = new AppService({ config });
  const controller = new AppController({ appService });

  fastify.get(
    '/apps/public/:environment/public-settings/by-id/:appId',
    controller.getPublicSettings.bind(controller)
  );

  fastify.get('/apps/:appId/public-settings', controller.getPublicSettings.bind(controller));
}
