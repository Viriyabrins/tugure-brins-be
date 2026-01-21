export default class NotificationService {
  constructor({ notificationRepository }) {
    this.repository = notificationRepository;
  }

  async list(filters) {
    return this.repository.list(filters);
  }

  async createNotification(payload) {
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
