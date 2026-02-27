import prisma from '../prisma/client.js';

export class NotificationSettingRepository {
  /**
   * Find a notification setting by Keycloak user ID.
   * Returns the setting row or null.
   */
  async findByKeycloakUserId(keycloakUserId) {
    return prisma.notificationSetting.findUnique({
      where: { keycloak_user_id: keycloakUserId },
    });
  }

  /**
   * Upsert a notification setting by Keycloak user ID.
   * Creates a new row if none exists, otherwise updates the existing row.
   */
  async upsertByKeycloakUserId(keycloakUserId, data) {
    // Separate keycloak_user_id from the rest of the data to avoid duplication
    const { keycloak_user_id, id, ...settingData } = data;

    return prisma.notificationSetting.upsert({
      where: { keycloak_user_id: keycloakUserId },
      create: {
        keycloak_user_id: keycloakUserId,
        ...settingData,
      },
      update: settingData,
    });
  }
}
