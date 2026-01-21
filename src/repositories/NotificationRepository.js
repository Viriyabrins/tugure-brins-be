import prisma from '../prisma/client.js';

export class NotificationRepository {
  async list({ target_role, unreadOnly, limit = 100 } = {}) {
    const where = {};
    if (target_role) where.targetRole = target_role;
    if (unreadOnly) where.isRead = true;

    return prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit
    });
  }

  async create(payload) {
    const {
      title,
      message,
      type = 'INFO',
      module = 'platform',
      reference_id = null,
      target_role = 'ALL'
    } = payload;

    return prisma.notification.create({
      data: {
        title,
        message,
        type,
        module,
        referenceId: reference_id,
        targetRole: target_role
      }
    });
  }

  async update(id, updates) {
    const data = {};
    if (typeof updates.is_read === 'boolean') data.isRead = updates.is_read;
    if (updates.message) data.message = updates.message;
    if (updates.title) data.title = updates.title;

    if (!Object.keys(data).length) return null;

    return prisma.notification.update({
      where: { id },
      data
    });
  }

  async delete(id) {
    return prisma.notification.delete({ where: { id } });
  }
}
