import { createNotificationFanout } from './NotificationDispatchService.js';

export default class NotificationService {
  constructor({ notificationRepository }) {
    this.repository = notificationRepository;
  }

  async list(filters) {
    return this.repository.list(filters);
  }

  async createNotification(payload) {
    const created = await createNotificationFanout(payload);
    if (created.length > 0) return created;
    return this.repository.create(payload);
  }

  async markAsRead(id) {
    return this.repository.update(id, { is_read: true });
  }

  async updateNotification(id, updates) {
    return this.repository.update(id, updates);
  }

  async delete(id) {
    return this.repository.delete(id);
  }
}
