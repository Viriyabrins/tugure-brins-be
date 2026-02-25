import prisma from '../prisma/client.js';

export class NotificationRepository {
  async list({ target_role, unreadOnly, limit = 100, page = 1 } = {}) {
    const where = {};
    if (target_role) {
      if (typeof target_role === 'string' && target_role.includes(',')) {
        where.target_role = { in: target_role.split(',').map(r => r.trim()) };
      } else {
        where.target_role = target_role;
      }
    }
    if (unreadOnly) where.is_read = false;

    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: limit,
        skip
      }),
      prisma.notification.count({ where })
    ]);

    return { data, pagination: { total, page, limit } };
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
        reference_id,
        target_role
      }
    });
  }

  async update(id, updates) {
    const data = {};
    if (typeof updates.is_read === 'boolean') data.is_read = updates.is_read;
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
