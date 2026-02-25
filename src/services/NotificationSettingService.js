export default class NotificationSettingService {
  constructor({ notificationSettingRepository }) {
    this.repo = notificationSettingRepository;
  }

  async getByKeycloakUserId(keycloakUserId) {
    if (!keycloakUserId) {
      const err = new Error('keycloak_user_id is required');
      err.statusCode = 400;
      throw err;
    }
    return this.repo.findByKeycloakUserId(keycloakUserId);
  }

  async upsertByKeycloakUserId(keycloakUserId, data) {
    if (!keycloakUserId) {
      const err = new Error('keycloak_user_id is required');
      err.statusCode = 400;
      throw err;
    }
    return this.repo.upsertByKeycloakUserId(keycloakUserId, data);
  }
}
