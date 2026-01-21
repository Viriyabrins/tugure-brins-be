import { sendSuccess, sendError } from '../utils/response.js';

export default class AppController {
  constructor({ appService }) {
    this.appService = appService;
  }

  async getPublicSettings(request, reply) {
    try {
      const settings = await this.appService.getPublicSettings(request.params.appId);
      return sendSuccess(reply, settings, 'Public settings retrieved');
    } catch (error) {
      return sendError(reply, error, error.statusCode || 500);
    }
  }
}
