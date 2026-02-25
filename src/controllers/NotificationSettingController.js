import { sendSuccess, sendError } from '../utils/response.js';

export default class NotificationSettingController {
  constructor({ notificationSettingService }) {
    this.service = notificationSettingService;
  }

  /**
   * GET /notification-settings/me?keycloak_user_id=<sub>
   * Returns the current user's notification settings, or null if none saved yet.
   */
  async getMySettings(request, reply) {
    try {
      const keycloakUserId = request.query?.keycloak_user_id;
      if (!keycloakUserId) {
        return sendError(reply, { message: 'keycloak_user_id query parameter is required' }, 400);
      }

      const setting = await this.service.getByKeycloakUserId(keycloakUserId);
      return sendSuccess(reply, setting);
    } catch (error) {
      return sendError(reply, error, error.statusCode || 500);
    }
  }

  /**
   * PUT /notification-settings/me
   * Upserts the current user's notification settings.
   * Body must include keycloak_user_id.
   */
  async upsertMySettings(request, reply) {
    try {
      const payload = request.body || {};
      const keycloakUserId = payload.keycloak_user_id;

      if (!keycloakUserId) {
        return sendError(reply, { message: 'keycloak_user_id is required in the request body' }, 400);
      }

      const result = await this.service.upsertByKeycloakUserId(keycloakUserId, payload);
      return sendSuccess(reply, result);
    } catch (error) {
      return sendError(reply, error, error.statusCode || 500);
    }
  }
}
