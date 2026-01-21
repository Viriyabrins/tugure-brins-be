export default class NotificationFlow {
  constructor({ notificationService }) {
    this.notificationService = notificationService;
  }

  async announce(payload) {
    if (!payload.title || !payload.message) {
      const error = new Error('Notification needs title and message');
      error.statusCode = 400;
      throw error;
    }

    return this.notificationService.createNotification(payload);
  }
}
