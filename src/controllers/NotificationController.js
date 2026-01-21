import { sendSuccess, sendCreated, sendError } from '../utils/response.js';

export default class NotificationController {
  constructor({ notificationService, notificationFlow }) {
    this.notificationService = notificationService;
    this.notificationFlow = notificationFlow;
  }

  async list(request, reply) {
    try {
      const filters = {
        target_role: request.query.target_role,
        unreadOnly: request.query.unread === 'true',
        limit: Number(request.query.limit) || 100
      };
      const notifications = await this.notificationService.list(filters);
      return sendSuccess(reply, notifications, 'Notifications fetched');
    } catch (error) {
      return sendError(reply, error, error.statusCode || 500);
    }
  }

  async create(request, reply) {
    try {
      const notification = await this.notificationFlow.announce(request.body);
      return sendCreated(reply, notification, 'Notification created');
    } catch (error) {
      return sendError(reply, error, error.statusCode || 400);
    }
  }

  async markAsRead(request, reply) {
    try {
      const notification = await this.notificationService.markAsRead(request.params.id);
      return sendSuccess(reply, notification, 'Notification marked read');
    } catch (error) {
      return sendError(reply, error, error.statusCode || 404);
    }
  }

  async update(request, reply) {
    try {
      const payload = await this.notificationService.updateNotification(request.params.id, request.body);
      return sendSuccess(reply, payload, 'Notification updated');
    } catch (error) {
      return sendError(reply, error, error.statusCode || 404);
    }
  }

  async delete(request, reply) {
    try {
      const deleted = await this.notificationService.delete(request.params.id);
      return sendSuccess(reply, deleted, 'Notification deleted');
    } catch (error) {
      return sendError(reply, error, error.statusCode || 404);
    }
  }
}
