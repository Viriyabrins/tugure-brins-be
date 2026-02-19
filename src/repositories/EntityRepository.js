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
  'DebitCreditNote',
  'AuditLog',
  'ReviseLog',
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

    if (prisma.batch && entity === 'Batch') {
      const rows = await prisma.batch.findMany({
        take: limit,
        orderBy: { batch_id: direction }
      });
      return rows.map((r) => ({ id: r.batch_id, ...r }));
    }

    if (prisma.claim && entity === 'Claim') {
      const rows = await prisma.claim.findMany({ take: limit, orderBy: { claim_no: direction } });
      return rows.map((r) => ({ id: r.claim_no, ...r }));
    }

    if (prisma.bordero && entity === 'Bordero') {
      const rows = await prisma.bordero.findMany({ take: limit, orderBy: { bordero_id: direction } });
      return rows.map((r) => ({ id: r.bordero_id, ...r }));
    }

    if (prisma.subrogation && entity === 'Subrogation') {
      const rows = await prisma.subrogation.findMany({ take: limit, orderBy: { subrogation_id: direction } });
      return rows.map((r) => ({ id: r.subrogation_id, ...r }));
    }

    if (prisma.masterContract && entity === 'MasterContract') {
      const rows = await prisma.masterContract.findMany({ take: limit, orderBy: { contract_id: direction } });
      return rows.map((r) => ({ id: r.contract_id, ...r }));
    }

    if (prisma.paymentIntent && entity === 'PaymentIntent') {
      const rows = await prisma.paymentIntent.findMany({
        take: limit,
        orderBy: { intent_id: direction }
      });
      return rows.map((r) => ({ id: r.intent_id, ...r }));
    }

    if (prisma.notification && entity === 'Notification') {
      const rows = await prisma.notification.findMany({
        take: limit,
        orderBy: { id: direction }
      });
      return rows.map((r) => ({ id: r.id, ...r }));
    }

    if (prisma.auditLog && entity === 'AuditLog') {
      const rows = await prisma.auditLog.findMany({
        take: limit,
        orderBy: { id: direction }
      });
      return rows.map((r) => ({ id: r.id, ...r }));
    }

    if (prisma.nota && entity === 'Nota') {
      const rows = await prisma.nota.findMany({ take: limit, orderBy: { nota_number: direction } });
      return rows.map((r) => ({ id: r.nota_number, ...r }));
    }

    if (prisma.reviseLog && entity === 'ReviseLog') {
      const rows = await prisma.reviseLog.findMany({
        take: limit,
        orderBy: { created_at: direction }
      });
      return rows.map((r) => ({ id: r.id, ...r }));
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

    if (prisma.masterContract && entity === 'MasterContract') {
      const r = await prisma.masterContract.findUnique({ where: { contract_id: id } });
      return r ? { id: r.contract_id, ...r } : null;
    }

    if (prisma.nota && entity === 'Nota') {
      const r = await prisma.nota.findUnique({ where: { nota_number: id } });
      return r ? { id: r.nota_number, ...r } : null;
    }

    if (prisma.paymentIntent && entity === 'PaymentIntent') {
      const r = await prisma.paymentIntent.findUnique({ where: { intent_id: id } });
      return r ? { id: r.intent_id, ...r } : null;
    }

    if (prisma.notification && entity === 'Notification') {
      const r = await prisma.notification.findUnique({ where: { id } });
      return r ? { id: r.id, ...r } : null;
    }

    if (prisma.auditLog && entity === 'AuditLog') {
      const r = await prisma.auditLog.findUnique({ where: { id } });
      return r ? { id: r.id, ...r } : null;
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

    if (entity === 'Batch' && prisma.batch && prisma.batch.create) {
      try {
        const r = await prisma.batch.create({ data: payload });
        return { id: r.batch_id, ...r };
      } catch (error) {
        console.error('Batch creation error:', error);
        throw error;
      }
    }

    // For dedicated models, insert minimally if possible
    if (entity === 'Debtor' && prisma.debtor && prisma.debtor.create) {
      try {
        const r = await prisma.debtor.create({ data: payload });
        return { id: r.id, ...r };
      } catch (error) {
        console.error('Debtor creation error:', error);
        throw error;
      }
    }

    if (entity === 'MasterContract' && prisma.masterContract && prisma.masterContract.create) {
      const r = await prisma.masterContract.create({ data: payload });
      return { id: r.contract_id, ...r };
    }

    // Dedicated model creation (PaymentIntent)
    if (entity === 'PaymentIntent' && prisma.paymentIntent && prisma.paymentIntent.create) {
      try {
        const r = await prisma.paymentIntent.create({ data: payload });
        return { id: r.intent_id, ...r };
      } catch (error) {
        console.error('PaymentIntent creation error:', error);
        throw error;
      }
    }

    // Dedicated model creation (Payment)
    if (entity === 'Payment' && prisma.payment && prisma.payment.create) {
      try {
        const r = await prisma.payment.create({ data: payload });
        return { id: r.payment_ref, ...r };
      } catch (error) {
        console.error('Payment creation error:', error);
        throw error;
      }
    }

    // Dedicated model creation (Claim)
    if (entity === 'Claim' && prisma.claim && prisma.claim.create) {
      try {
        const r = await prisma.claim.create({ data: payload });
        return { id: r.claim_no, ...r };
      } catch (error) {
        console.error('Claim creation error:', error);
        throw error;
      }
    }

    // Dedicated model creation (Nota)
    if (entity === 'Nota' && prisma.nota && prisma.nota.create) {
      try {
        const r = await prisma.nota.create({ data: payload });
        return { id: r.nota_number, ...r };
      } catch (error) {
        console.error('Nota creation error:', error);
        throw error;
      }
    }

    if (entity === 'Notification' && prisma.notification && prisma.notification.create) {
      try {
        const r = await prisma.notification.create({ data: payload });
        return { id: r.id, ...r };
      } catch (error) {
        console.error('Notification creation error:', error);
        throw error;
      }
    }

    if (entity === 'AuditLog' && prisma.auditLog && prisma.auditLog.create) {
      try {
        const r = await prisma.auditLog.create({ data: payload });
        return { id: r.id, ...r };
      } catch (error) {
        console.error('AuditLog creation error:', error);
        throw error;
      }
    }

    if (entity === 'ReviseLog' && prisma.reviseLog && prisma.reviseLog.create) {
      try {
        const r = await prisma.reviseLog.create({ data: payload });
        return { id: r.id, ...r };
      } catch (error) {
        console.error('ReviseLog creation error:', error);
        throw error;
      }
    }

    // Dedicated model creation (Bordero)
    if (entity === 'Bordero' && prisma.bordero && prisma.bordero.create) {
      try {
        const r = await prisma.bordero.create({ data: payload });
        return { id: r.bordero_id, ...r };
      } catch (error) {
        console.error('Bordero creation error:', error);
        throw error;
      }
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

    if (entity === 'Batch' && prisma.batch && prisma.batch.update) {
      const existing = await prisma.batch.findUnique({ where: { batch_id: id } });
      if (!existing) return null;
      const r = await prisma.batch.update({ where: { batch_id: id }, data: payload });
      return { id: r.batch_id, ...r };
    }

    // Dedicated model updates (Debtor)
    if (entity === 'Debtor' && prisma.debtor && prisma.debtor.update) {
      const existing = await prisma.debtor.findUnique({ where: { id } });
      if (!existing) return null;
      const r = await prisma.debtor.update({ where: { id }, data: payload });
      return { id: r.id, ...r };
    }

    // Dedicated model updates (MasterContract)
    if (entity === 'MasterContract' && prisma.masterContract && prisma.masterContract.update) {
      const existing = await prisma.masterContract.findUnique({ where: { contract_id: id } });
      if (!existing) return null;
      const r = await prisma.masterContract.update({ where: { contract_id: id }, data: payload });
      return { id: r.contract_id, ...r };
    }

    // Dedicated model updates (Nota)
    if (entity === 'Nota' && prisma.nota && prisma.nota.update) {
      const existing = await prisma.nota.findUnique({ where: { nota_number: id } });
      if (!existing) {
        const error = new Error(`Nota ${id} not found`);
        error.statusCode = 404;
        throw error;
      }
      const r = await prisma.nota.update({
        where: { nota_number: id },
        data: payload
      });
      return { id: r.nota_number, ...r };
    }

    if (entity === 'PaymentIntent' && prisma.paymentIntent && prisma.paymentIntent.update) {
      const existing = await prisma.paymentIntent.findUnique({ where: { intent_id: id } });
      if (!existing) {
        const error = new Error(`PaymentIntent ${id} not found`);
        error.statusCode = 404;
        throw error;
      }
      const r = await prisma.paymentIntent.update({
        where: { intent_id: id },
        data: payload
      });
      return { id: r.intent_id, ...r };
    }

    if (entity === 'Notification' && prisma.notification && prisma.notification.update) {
      const existing = await prisma.notification.findUnique({ where: { id } });
      if (!existing) {
        const error = new Error(`Notification ${id} not found`);
        error.statusCode = 404;
        throw error;
      }
      const r = await prisma.notification.update({
        where: { id },
        data: payload
      });
      return { id: r.id, ...r };
    }

    if (entity === 'AuditLog' && prisma.auditLog && prisma.auditLog.update) {
      const existing = await prisma.auditLog.findUnique({ where: { id } });
      if (!existing) {
        const error = new Error(`AuditLog ${id} not found`);
        error.statusCode = 404;
        throw error;
      }
      const r = await prisma.auditLog.update({
        where: { id },
        data: payload
      });
      return { id: r.id, ...r };
    }

    if (entity === 'Claim' && prisma.claim && prisma.claim.update) {
      const existing = await prisma.claim.findUnique({ where: { claim_no: id } });
      if (!existing) return null;
      const r = await prisma.claim.update({ where: { claim_no: id }, data: payload });
      return { id: r.claim_no, ...r };
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

    if (entity === 'Notification' && prisma.notification && prisma.notification.delete) {
      const existing = await prisma.notification.findUnique({ where: { id } });
      if (!existing) return null;
      await prisma.notification.delete({ where: { id } });
      return { id };
    }

    if (entity === 'AuditLog' && prisma.auditLog && prisma.auditLog.delete) {
      const existing = await prisma.auditLog.findUnique({ where: { id } });
      if (!existing) return null;
      await prisma.auditLog.delete({ where: { id } });
      return { id };
    }

    return null;
  }
}
