import prisma from '../prisma/client.js';

const ALLOWED_ENTITIES = [
  'Debtor',
  'Batch',
  'Claim',
  'Nota',
  'Notification',
  'NotificationSetting',
  'EmailTemplate',
  'Payment',
  'PaymentIntent',
  'Record',
  'SystemConfig',
  'SlaRule',
  'Subrogation',
  'Document',
  'Bordero',
  'MasterContract',
  'Contract',
  'Invoice',
  'DebitCreditNote'
];

const ensureEntity = (entity) => {
  if (!ALLOWED_ENTITIES.includes(entity)) {
    const error = new Error(`Entity ${entity} is not supported`);
    error.statusCode = 404;
    throw error;
  }
  return entity;
};

export class EntityRepository {
  async list(entity, { limit = 100, sort = 'desc' } = {}) {
    ensureEntity(entity);
    const direction = sort === 'asc' ? 'asc' : 'desc';
    // Prefer dedicated tables when available (Debtor, Claim, Bordero), otherwise fall back
    // to the generic `entityRecord` table if present.
    if (prisma.debtor && entity === 'Debtor') {
      const rows = await prisma.debtor.findMany({ take: limit, orderBy: { id: direction } });
      return rows.map((r) => ({ id: r.id, ...r }));
    }

    if (prisma.claim && entity === 'Claim') {
      const rows = await prisma.claim.findMany({ take: limit, orderBy: { claim_no: direction } });
      return rows.map((r) => ({ id: r.claim_no, ...r }));
    }

    if (prisma.bordero && entity === 'Bordero') {
      const rows = await prisma.bordero.findMany({ take: limit, orderBy: { bordero_id: direction } });
      return rows.map((r) => ({ id: r.bordero_id, ...r }));
    }

    if (prisma.entityRecord && prisma.entityRecord.findMany) {
      const records = await prisma.entityRecord.findMany({
        where: { entityName: entity },
        take: limit,
        orderBy: { createdAt: direction }
      });
      return records.map((row) => ({ id: row.id, ...row.payload }));
    }

    // If no backing model exists, return empty list instead of throwing a runtime error.
    return [];
  }

  async get(entity, id) {
    ensureEntity(entity);
    // Try model-specific lookups first
    if (prisma.debtor && entity === 'Debtor') {
      const r = await prisma.debtor.findUnique({ where: { id } });
      return r ? { id: r.id, ...r } : null;
    }

    if (prisma.claim && entity === 'Claim') {
      const r = await prisma.claim.findUnique({ where: { claim_no: id } });
      return r ? { id: r.claim_no, ...r } : null;
    }

    if (prisma.bordero && entity === 'Bordero') {
      const r = await prisma.bordero.findUnique({ where: { bordero_id: id } });
      return r ? { id: r.bordero_id, ...r } : null;
    }

    if (!prisma.entityRecord || !prisma.entityRecord.findUnique) return null;

    const record = await prisma.entityRecord.findUnique({ where: { id } });
    if (!record || record.entityName !== entity) return null;
    return { id: record.id, ...record.payload };
  }

  async create(entity, payload) {
    ensureEntity(entity);
    if (prisma.entityRecord && prisma.entityRecord.create) {
      const record = await prisma.entityRecord.create({
        data: {
          entityName: entity,
          payload
        }
      });
      return { id: record.id, ...record.payload };
    }

    // For dedicated models, insert minimally if possible
    if (entity === 'Debtor' && prisma.debtor && prisma.debtor.create) {
      const r = await prisma.debtor.create({ data: payload });
      return { id: r.id, ...r };
    }

    throw Object.assign(new Error('Create not supported for this entity in current schema'), { statusCode: 500 });
  }

  async update(entity, id, payload) {
    ensureEntity(entity);
    if (prisma.entityRecord && prisma.entityRecord.findUnique) {
      const existing = await prisma.entityRecord.findUnique({ where: { id } });
      if (!existing || existing.entityName !== entity) return null;
      const record = await prisma.entityRecord.update({
        where: { id },
        data: { payload }
      });
      return { id: record.id, ...record.payload };
    }

    // Dedicated model updates (Debtor)
    if (entity === 'Debtor' && prisma.debtor && prisma.debtor.update) {
      const existing = await prisma.debtor.findUnique({ where: { id } });
      if (!existing) return null;
      const r = await prisma.debtor.update({ where: { id }, data: payload });
      return { id: r.id, ...r };
    }

    return null;
  }

  async delete(entity, id) {
    ensureEntity(entity);
    if (prisma.entityRecord && prisma.entityRecord.findUnique) {
      const existing = await prisma.entityRecord.findUnique({ where: { id } });
      if (!existing || existing.entityName !== entity) return null;
      await prisma.entityRecord.delete({ where: { id } });
      return { id };
    }

    if (entity === 'Debtor' && prisma.debtor && prisma.debtor.delete) {
      const existing = await prisma.debtor.findUnique({ where: { id } });
      if (!existing) return null;
      await prisma.debtor.delete({ where: { id } });
      return { id };
    }

    return null;
  }
}
