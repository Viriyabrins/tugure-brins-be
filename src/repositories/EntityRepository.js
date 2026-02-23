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
  async reconcileBatchAfterDebtorUpdate(batchId, { approvedBy } = {}) {
    if (!batchId || !prisma.batch || !prisma.debtor) return null;

    const existingBatch = await prisma.batch.findUnique({ where: { batch_id: batchId } });
    if (!existingBatch) return null;

    const debtors = await prisma.debtor.findMany({
      where: { batch_id: batchId },
      select: {
        status: true,
        plafon: true,
        net_premi: true,
      },
    });

    const normalizeStatus = (status) => (status || '').toString().toUpperCase();
    const toNumber = (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    };

    const totalDebtors = debtors.length;
    const approvedDebtors = debtors.filter((d) => normalizeStatus(d.status) === 'APPROVED');
    const revisionDebtors = debtors.filter((d) => normalizeStatus(d.status) === 'REVISION');
    const approvedCount = approvedDebtors.length;
    const hasRevisions = revisionDebtors.length > 0;
    const allApproved = totalDebtors > 0 && approvedCount === totalDebtors;
    const allReviewed = totalDebtors > 0 && debtors.every((d) => {
      const status = normalizeStatus(d.status);
      return status === 'APPROVED' || status === 'REVISION' || status === 'CONDITIONAL';
    });

    const finalExposureAmount = approvedDebtors.reduce((sum, debtor) => sum + toNumber(debtor.plafon), 0);
    const finalPremiumAmount = approvedDebtors.reduce((sum, debtor) => sum + toNumber(debtor.net_premi), 0);

    const updatePayload = {
      final_exposure_amount: finalExposureAmount,
      final_premium_amount: finalPremiumAmount,
      debtor_review_completed: allApproved,
      batch_ready_for_nota: allApproved,
    };

    if (allApproved) {
      updatePayload.status = 'Approved';
      updatePayload.approved_date = new Date();
      if (approvedBy) updatePayload.approved_by = approvedBy;
      updatePayload.revision_reason = null;
    } else if (approvedCount === 0 && hasRevisions) {
      updatePayload.status = 'Revision';
      updatePayload.revision_reason = 'All debtors marked for revision in review';
    } else if (hasRevisions && allReviewed) {
      updatePayload.status = 'Partial Revision';
      updatePayload.revision_reason = `${revisionDebtors.length} debtor(s) marked for revision`;
    }

    const updated = await prisma.batch.update({
      where: { batch_id: batchId },
      data: updatePayload,
    });

    const previousStatus = (existingBatch.status || '').toString();
    const currentStatus = (updated.status || '').toString();
    const completionChanged = Boolean(existingBatch.debtor_review_completed) !== Boolean(updated.debtor_review_completed);
    const statusChanged = previousStatus !== currentStatus;
    const actorEmail = approvedBy || existingBatch.approved_by || 'system@backend.local';

    if (statusChanged || completionChanged) {
      const notifications = [];

      if (Boolean(updated.debtor_review_completed)) {
        notifications.push(
          {
            title: '✅ Debtor Review COMPLETED - Ready for Nota',
            message: `Batch ${batchId}: ALL ${totalDebtors} debtors reviewed. ${approvedCount} approved. Final premium: Rp ${finalPremiumAmount.toLocaleString('id-ID')}.`,
            type: 'ACTION_REQUIRED',
            module: 'DEBTOR',
            reference_id: updated.batch_id,
            target_role: 'TUGURE',
          },
          {
            title: '✅ Debtor Review COMPLETED - Ready for Nota',
            message: `Batch ${batchId} selesai direview dan siap lanjut ke proses nota.`,
            type: 'INFO',
            module: 'DEBTOR',
            reference_id: updated.batch_id,
            target_role: 'BRINS',
          },
        );
      } else if (currentStatus === 'Revision') {
        notifications.push({
          title: 'Batch Requires Revision - All Debtors Marked',
          message: `Batch ${batchId}: semua debtor berstatus revision dan perlu diperbaiki oleh BRINS.`,
          type: 'WARNING',
          module: 'DEBTOR',
          reference_id: updated.batch_id,
          target_role: 'BRINS',
        });
      } else if (currentStatus === 'Partial Revision') {
        notifications.push({
          title: 'Batch Partial Revision',
          message: `Batch ${batchId}: ${approvedCount} approved, ${revisionDebtors.length} debtor perlu revision.`,
          type: 'WARNING',
          module: 'DEBTOR',
          reference_id: updated.batch_id,
          target_role: 'BRINS',
        });
      }

      for (const notification of notifications) {
        try {
          await prisma.notification.create({ data: notification });
        } catch (error) {
          console.warn('Failed to create batch reconciliation notification:', error);
        }
      }

      try {
        await prisma.auditLog.create({
          data: {
            action: Boolean(updated.debtor_review_completed)
              ? 'DEBTOR_REVIEW_COMPLETED'
              : statusChanged
                ? `BATCH_STATUS_${currentStatus.toString().toUpperCase().replace(/\s+/g, '_')}`
                : 'BATCH_RECONCILED',
            module: 'DEBTOR',
            entity_type: 'Batch',
            entity_id: updated.batch_id,
            old_value: JSON.stringify({
              status: existingBatch.status,
              debtor_review_completed: existingBatch.debtor_review_completed,
              batch_ready_for_nota: existingBatch.batch_ready_for_nota,
              final_exposure_amount: existingBatch.final_exposure_amount,
              final_premium_amount: existingBatch.final_premium_amount,
            }),
            new_value: JSON.stringify({
              status: updated.status,
              debtor_review_completed: updated.debtor_review_completed,
              batch_ready_for_nota: updated.batch_ready_for_nota,
              final_exposure_amount: updated.final_exposure_amount,
              final_premium_amount: updated.final_premium_amount,
            }),
            user_email: actorEmail,
            user_role: approvedBy ? 'TUGURE' : 'SYSTEM',
            reason: `Reconciled batch ${batchId}: ${approvedCount}/${totalDebtors} approved`,
          },
        });
      } catch (error) {
        console.warn('Failed to create batch reconciliation audit log:', error);
      }
    }

    return {
      id: updated.batch_id,
      ...updated,
      stats: {
        totalDebtors,
        approvedCount,
        revisionCount: revisionDebtors.length,
      },
    };
  }

  async list(entity, { limit = 100, sort = 'desc', offset = 0, page = 1, filters = {} } = {}) {
    ensureEntity(entity);
    const direction = sort === 'asc' ? 'asc' : 'desc';
    // When limit > 0, apply skip/take for pagination. When limit === 0, return all records.
    const paginationOpts = limit > 0 ? { skip: offset, take: limit } : {};

    // Prefer dedicated tables when available (Debtor, Claim, Bordero), otherwise fall back
    // to the generic `entityRecord` table if present.
    if (prisma.debtor && entity === 'Debtor') {
      const where = {};
      if (filters) {
        if (filters.contract && filters.contract !== 'all') where.contract_id = filters.contract;
        if (filters.batch) where.batch_id = { contains: filters.batch };
        // Debtor model uses `status` for underwriting status
        if (filters.submitStatus && filters.submitStatus !== 'all') where.status = filters.submitStatus;
        if (filters.status && filters.status !== 'all' && !filters.submitStatus) where.status = filters.status;
        if (filters.name) {
          const keyword = String(filters.name).trim();
          if (keyword) {
            where.OR = [
              { nama_peserta: { contains: keyword, mode: 'insensitive' } },
              { nomor_peserta: { contains: keyword, mode: 'insensitive' } },
              { batch_id: { contains: keyword, mode: 'insensitive' } },
            ];
          }
        }
        // Batch status lives on `Batch` table. If provided, find matching batch_ids first.
        if (filters.status && filters.status !== 'all') {
          const matching = await prisma.batch.findMany({ where: { status: filters.status }, select: { batch_id: true } });
          const ids = matching.map((b) => b.batch_id);
          // if no matching batches, ensure no debtors returned
          where.batch_id = ids.length > 0 ? { in: ids } : { in: [] };
        }
        // Use `tanggal_terima` as debtor received/created date
        if (filters.startDate || filters.endDate) {
          where.tanggal_terima = {};
          if (filters.startDate) where.tanggal_terima.gte = new Date(filters.startDate);
          if (filters.endDate) where.tanggal_terima.lte = new Date(filters.endDate);
        }
      }
      const total = await prisma.debtor.count({ where });
      const rows = await prisma.debtor.findMany({ where, ...paginationOpts, orderBy: { id: direction } });
      return { data: rows.map((r) => ({ id: r.id, ...r })), total };
    }

    if (prisma.batch && entity === 'Batch') {
      const total = await prisma.batch.count();
      const rows = await prisma.batch.findMany({ ...paginationOpts, orderBy: { batch_id: direction } });
      return { data: rows.map((r) => ({ id: r.batch_id, ...r })), total };
    }

    if (prisma.claim && entity === 'Claim') {
      const total = await prisma.claim.count();
      const rows = await prisma.claim.findMany({ ...paginationOpts, orderBy: { claim_no: direction } });
      return { data: rows.map((r) => ({ id: r.claim_no, ...r })), total };
    }

    if (prisma.bordero && entity === 'Bordero') {
      const total = await prisma.bordero.count();
      const rows = await prisma.bordero.findMany({ ...paginationOpts, orderBy: { bordero_id: direction } });
      return { data: rows.map((r) => ({ id: r.bordero_id, ...r })), total };
    }

    if (prisma.subrogation && entity === 'Subrogation') {
      const total = await prisma.subrogation.count();
      const rows = await prisma.subrogation.findMany({ ...paginationOpts, orderBy: { subrogation_id: direction } });
      return { data: rows.map((r) => ({ id: r.subrogation_id, ...r })), total };
    }

    if (prisma.masterContract && entity === 'MasterContract') {
      const total = await prisma.masterContract.count();
      const rows = await prisma.masterContract.findMany({ ...paginationOpts, orderBy: { contract_id: direction } });
      return { data: rows.map((r) => ({ id: r.contract_id, ...r })), total };
    }

    if (prisma.paymentIntent && entity === 'PaymentIntent') {
      const total = await prisma.paymentIntent.count();
      const rows = await prisma.paymentIntent.findMany({ ...paginationOpts, orderBy: { intent_id: direction } });
      return { data: rows.map((r) => ({ id: r.intent_id, ...r })), total };
    }

    if (prisma.notification && entity === 'Notification') {
      const total = await prisma.notification.count();
      const rows = await prisma.notification.findMany({ ...paginationOpts, orderBy: { id: direction } });
      return { data: rows.map((r) => ({ id: r.id, ...r })), total };
    }

    if (prisma.auditLog && entity === 'AuditLog') {
      const total = await prisma.auditLog.count();
      const rows = await prisma.auditLog.findMany({ ...paginationOpts, orderBy: { id: direction } });
      return { data: rows.map((r) => ({ id: r.id, ...r })), total };
    }

    if (prisma.nota && entity === 'Nota') {
      const total = await prisma.nota.count();
      const rows = await prisma.nota.findMany({ ...paginationOpts, orderBy: { nota_number: direction } });
      return { data: rows.map((r) => ({ id: r.nota_number, ...r })), total };
    }

    if (prisma.reviseLog && entity === 'ReviseLog') {
      const where = {};
      if (filters) {
        if (filters.contract && filters.contract !== 'all') where.contract_id = filters.contract;
        if (filters.batch) where.batch_id = { contains: filters.batch, mode: 'insensitive' };
        if (filters.name) {
          const keyword = String(filters.name).trim();
          if (keyword) {
            where.OR = [
              { nama_peserta: { contains: keyword, mode: 'insensitive' } },
              { nomor_peserta: { contains: keyword, mode: 'insensitive' } },
              { batch_id: { contains: keyword, mode: 'insensitive' } },
            ];
          }
        }
        if (filters.submitStatus && filters.submitStatus !== 'all') {
          where.status = filters.submitStatus;
        } else if (
          filters.status &&
          ['SUBMITTED', 'APPROVED', 'REVISION', 'CONDITIONAL'].includes(filters.status)
        ) {
          where.status = filters.status;
        }
        if (filters.startDate || filters.endDate) {
          where.created_at = {};
          if (filters.startDate) where.created_at.gte = new Date(filters.startDate);
          if (filters.endDate) where.created_at.lte = new Date(filters.endDate);
        }
      }

      const total = await prisma.reviseLog.count({ where });
      const rows = await prisma.reviseLog.findMany({ where, ...paginationOpts, orderBy: { created_at: direction } });
      return { data: rows.map((r) => ({ id: r.id, ...r })), total };
    }

    if (prisma.entityRecord && prisma.entityRecord.findMany) {
      const where = { entityName: entity };
      const total = await prisma.entityRecord.count({ where });
      const records = await prisma.entityRecord.findMany({ where, ...paginationOpts, orderBy: { createdAt: direction } });
      return { data: records.map((row) => ({ id: row.id, ...row.payload })), total };
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
        // Business rule: a SUBMITTED debtor must be linked to exactly one Bordero
        if (payload?.status === 'SUBMITTED' && !payload?.bordero_id) {
          const error = new Error('Debtor SUBMITTED must include bordero_id');
          error.statusCode = 400;
          throw error;
        }
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

    // Dedicated model creation (Record)
    if (entity === 'Record' && prisma.record && prisma.record.create) {
      try {
        const r = await prisma.record.create({ data: payload });
        return { id: r.id, ...r };
      } catch (error) {
        console.error('Record creation error:', error);
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

    // Dedicated model updates (Bordero)
    if (entity === 'Bordero' && prisma.bordero && prisma.bordero.update) {
      const existing = await prisma.bordero.findUnique({ where: { bordero_id: id } });
      if (!existing) return null;
      const r = await prisma.bordero.update({ where: { bordero_id: id }, data: payload });
      return { id: r.bordero_id, ...r };
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

    if (entity === 'Batch' && prisma.batch && prisma.batch.delete) {
      const existing = await prisma.batch.findUnique({ where: { batch_id: id } });
      if (!existing) return null;
      await prisma.batch.delete({ where: { batch_id: id } });
      return { id };
    }

    if (entity === 'Bordero' && prisma.bordero && prisma.bordero.delete) {
      const existing = await prisma.bordero.findUnique({ where: { bordero_id: id } });
      if (!existing) return null;
      await prisma.bordero.delete({ where: { bordero_id: id } });
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
