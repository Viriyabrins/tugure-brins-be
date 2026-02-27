import prisma from '../prisma/client.js';

export default class EntityService {
  constructor({ entityRepository }) {
    this.entityRepository = entityRepository;
  }

  decodeJwtPayload(jwt) {
    if (!jwt || typeof jwt !== 'string') return null;
    const parts = jwt.split('.');
    if (parts.length < 2) return null;

    try {
      const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
      return JSON.parse(Buffer.from(normalized + padding, 'base64').toString('utf8'));
    } catch {
      return null;
    }
  }

  extractRolesFromPayload(tokenPayload) {
    if (!tokenPayload || typeof tokenPayload !== 'object') return [];

    const realmRoles = Array.isArray(tokenPayload.realm_access?.roles)
      ? tokenPayload.realm_access.roles
      : [];

    const resourceAccess = tokenPayload.resource_access && typeof tokenPayload.resource_access === 'object'
      ? tokenPayload.resource_access
      : {};

    const clientRoles = Object.values(resourceAccess)
      .flatMap((clientEntry) => (Array.isArray(clientEntry?.roles) ? clientEntry.roles : []));

    return [...realmRoles, ...clientRoles];
  }

  resolveAuditActor(context = {}) {
    const user = context?.user || {};
    const tokenPayload = this.decodeJwtPayload(user.token);

    const tokenRoles = this.extractRolesFromPayload(tokenPayload);
    const userRoles = Array.isArray(user.roles)
      ? user.roles
      : user.role
        ? [user.role]
        : [];

    const roleList = tokenRoles.length > 0 ? tokenRoles : userRoles;
    const normalizedRoles = roleList
      .map((role) => String(role).trim().toLowerCase())
      .filter(Boolean);

    const businessRoles = normalizedRoles.filter(
      (role) =>
        !role.startsWith('default-roles-') &&
        role !== 'offline_access' &&
        role !== 'uma_authorization'
    );

    const rolePriority = [
      'maker-brins-role',
      'checker-brins-role',
      'approver-tugure-role',
      'checker-tugure-role',
      'approver-brins-role'
    ];

    const prioritizedRole =
      rolePriority.find((role) => businessRoles.includes(role)) ||
      businessRoles[0] ||
      normalizedRoles[0] ||
      'USER';

    const userEmail =
      tokenPayload?.email ||
      tokenPayload?.preferred_username ||
      tokenPayload?.upn ||
      tokenPayload?.sub ||
      user?.email ||
      user?.id ||
      'unknown';

    return {
      user_email: userEmail,
      user_role: prioritizedRole,
    };
  }

  enforceAuditActor(payload = {}, context = {}) {
    const actor = this.resolveAuditActor(context);
    return {
      ...payload,
      user_email: actor.user_email,
      user_role: actor.user_role,
      ip_address: payload?.ip_address || context?.ipAddress || null,
    };
  }

  buildReadableError(error, fallbackMessage = 'Operation failed') {
    if (!error) {
      const e = new Error(fallbackMessage);
      e.statusCode = 500;
      return e;
    }

    if (error.code === 'P2002') {
      const target = Array.isArray(error.meta?.target)
        ? error.meta.target.join(', ')
        : String(error.meta?.target || 'unique field');
      const e = new Error(`Data sudah ada. Nilai pada ${target} harus unik.`);
      e.statusCode = 409;
      return e;
    }

    if (error.code === 'P2003') {
      const e = new Error('Data tidak bisa diproses karena relasi referensi tidak valid.');
      e.statusCode = 400;
      return e;
    }

    if (error.code === 'P2025') {
      const e = new Error('Data yang diminta tidak ditemukan atau sudah berubah.');
      e.statusCode = 404;
      return e;
    }

    if (error instanceof Error) {
      if (!error.statusCode) error.statusCode = 500;
      return error;
    }

    const e = new Error(fallbackMessage);
    e.statusCode = 500;
    return e;
  }

  async uploadMasterContractsAtomic(payload = {}, context = {}) {
    const contracts = Array.isArray(payload.contracts) ? payload.contracts : [];
    const uploadMode = String(payload.uploadMode || 'new').toLowerCase();
    const selectedContractForRevision = payload.selectedContractForRevision || null;
    const selectedRevisionValue = String(selectedContractForRevision || '').trim();
    const actor = this.resolveAuditActor(context);

    if (contracts.length === 0) {
      const error = new Error('File upload kosong. Tidak ada data kontrak yang bisa diproses.');
      error.statusCode = 400;
      throw error;
    }

    if (uploadMode === 'revise' && !selectedRevisionValue) {
      const error = new Error('Mode revisi membutuhkan contract yang dipilih.');
      error.statusCode = 400;
      throw error;
    }

    let revisionBaseContract = null;
    let revisionContractNo = null;

    if (uploadMode === 'new') {
      const contractIds = contracts
        .map((item) => String(item?.contract_id || '').trim())
        .filter(Boolean);

      if (contractIds.length !== contracts.length) {
        const error = new Error('Sebagian baris tidak memiliki contract_id yang valid. Periksa kembali template upload.');
        error.statusCode = 400;
        throw error;
      }

      const duplicateInFile = contractIds.find((id, index) => contractIds.indexOf(id) !== index);
      if (duplicateInFile) {
        const error = new Error(`Terdapat contract_id duplikat di file upload: ${duplicateInFile}`);
        error.statusCode = 400;
        throw error;
      }

      const existing = await prisma.masterContract.findMany({
        where: { contract_id: { in: contractIds } },
        select: { contract_id: true },
      });

      if (existing.length > 0) {
        const existsList = existing.map((item) => item.contract_id).join(', ');
        const error = new Error(`Upload dibatalkan karena contract_id sudah terdaftar: ${existsList}`);
        error.statusCode = 409;
        throw error;
      }
    } else {
      revisionBaseContract = await prisma.masterContract.findUnique({
        where: { contract_id: selectedRevisionValue },
      });

      if (!revisionBaseContract) {
        revisionBaseContract = await prisma.masterContract.findFirst({
          where: {
            contract_no: selectedRevisionValue,
            contract_status: {
              equals: 'REVISION',
              mode: 'insensitive',
            },
          },
          orderBy: { version: 'desc' },
        });
      }

      if (!revisionBaseContract) {
        const error = new Error('Kontrak yang dipilih untuk revisi tidak ditemukan berdasarkan contract_id atau contract_no.');
        error.statusCode = 404;
        throw error;
      }

      const status = String(revisionBaseContract.contract_status || '').trim().toUpperCase();
      if (status !== 'REVISION') {
        const error = new Error('Kontrak yang bisa direvisi hanya yang berstatus REVISION.');
        error.statusCode = 400;
        throw error;
      }

      revisionContractNo = String(revisionBaseContract.contract_no || '').trim();
      if (!revisionContractNo) {
        const error = new Error('Kontrak revisi tidak memiliki contract_no sebagai acuan.');
        error.statusCode = 400;
        throw error;
      }

      for (let i = 0; i < contracts.length; i += 1) {
        const incomingContractNo = String(contracts[i]?.contract_no || '').trim();
        if (!incomingContractNo) {
          const error = new Error(`Baris ke-${i + 1}: contract_no wajib diisi dan harus sama dengan kontrak yang direvisi (${revisionContractNo}).`);
          error.statusCode = 400;
          throw error;
        }
        if (incomingContractNo !== revisionContractNo) {
          const error = new Error(`Baris ke-${i + 1}: contract_no harus sama dengan kontrak yang direvisi (${revisionContractNo}).`);
          error.statusCode = 400;
          throw error;
        }
      }
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        const createdContracts = [];
        let revisionVersionStart = 1;

        const sanitizeIdPart = (value = '') =>
          String(value)
            .toUpperCase()
            .replace(/[^A-Z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 45);

        if (uploadMode === 'revise') {
          const versionRows = await tx.masterContract.findMany({
            where: { contract_no: revisionContractNo },
            select: { version: true },
          });

          const maxVersion = versionRows.reduce((max, row) => {
            const current = Number(row?.version);
            if (Number.isFinite(current)) return Math.max(max, current);
            return max;
          }, 0);

          revisionVersionStart = maxVersion + 1;

          const { ...archivedRevisionPayload } = revisionBaseContract;
          await tx.contractRevise.create({
            data: {
              ...archivedRevisionPayload,
              contract_status: 'REVISION',
            },
          });

          await tx.masterContract.delete({
            where: { contract_id: revisionBaseContract.contract_id },
          });
        }

        for (let i = 0; i < contracts.length; i += 1) {
          const row = { ...(contracts[i] || {}) };

          if (uploadMode === 'revise') {
            const nextVersion = revisionVersionStart + i;
            const baseId = sanitizeIdPart(revisionBaseContract.contract_id || revisionContractNo || 'MC');
            const candidateId = `${baseId}-REV-${String(nextVersion).padStart(3, '0')}`;

            row.contract_id = candidateId;
            row.contract_no = revisionContractNo;
            row.version = nextVersion;
            row.parent_contract_id = revisionBaseContract.contract_id;
            row.contract_status = row.contract_status || 'Draft';
          }

          try {
            const created = await tx.masterContract.create({ data: row });
            createdContracts.push(created);
          } catch (error) {
            const wrappedError = this.buildReadableError(
              error,
              `Gagal menyimpan data pada baris ke-${i + 1}.`
            );
            if (!wrappedError.message.includes('baris ke-')) {
              wrappedError.message = `Baris ke-${i + 1}: ${wrappedError.message}`;
            }
            throw wrappedError;
          }
        }

        await tx.auditLog.create({
          data: {
            action: uploadMode === 'revise' ? 'MASTER_CONTRACT_REVISED_BULK' : 'MASTER_CONTRACT_UPLOADED_BULK',
            module: 'CONFIG',
            entity_type: 'MasterContract',
            entity_id: createdContracts.map((item) => item.contract_id).join(', '),
            old_value: null,
            new_value: JSON.stringify({
              upload_mode: uploadMode,
              total_uploaded: createdContracts.length,
              contract_ids: createdContracts.map((item) => item.contract_id),
            }),
            user_email: actor.user_email,
            user_role: actor.user_role,
            reason: uploadMode === 'revise'
              ? `Bulk revise upload for ${selectedContractForRevision} (${revisionContractNo})`
              : 'Bulk upload from Master Contract Management',
            ip_address: context?.ipAddress || null,
          },
        });

        await tx.notification.create({
          data: {
            title: uploadMode === 'revise' ? 'Master Contract Revision Uploaded' : 'Master Contract Uploaded',
            message: `${createdContracts.length} master contract berhasil di-upload (${uploadMode}).`,
            type: 'INFO',
            module: 'CONFIG',
            reference_type: 'MasterContract',
            reference_id: createdContracts[0]?.contract_id || null,
            target_role: 'ALL',
          },
        });

        return {
          createdCount: createdContracts.length,
          contracts: createdContracts,
        };
      });

      return result;
    } catch (error) {
      throw this.buildReadableError(error, 'Upload master contract gagal diproses.');
    }
  }

  async processMasterContractApprovalAtomic(contractId, payload = {}, context = {}) {
    const id = String(contractId || '').trim();
    const action = String(payload.action || '').trim().toUpperCase();
    const remarks = payload.remarks ? String(payload.remarks) : null;
    const actor = this.resolveAuditActor(context);

    if (!id) {
      const error = new Error('Contract ID wajib diisi.');
      error.statusCode = 400;
      throw error;
    }

    if (!['APPROVED', 'REVISION'].includes(action)) {
      const error = new Error('Aksi approval tidak valid. Gunakan APPROVED atau REVISION.');
      error.statusCode = 400;
      throw error;
    }

    try {
      return await prisma.$transaction(async (tx) => {
        const existing = await tx.masterContract.findUnique({ where: { contract_id: id } });
        if (!existing) {
          const error = new Error(`Master Contract ${id} tidak ditemukan.`);
          error.statusCode = 404;
          throw error;
        }

        const updates = {};
        if (action === 'APPROVED') {
          updates.contract_status = 'APPROVED';
          updates.first_approved_by = actor.user_email;
          updates.first_approved_date = new Date();
          if (remarks) updates.remark = remarks;
        } else {
          updates.contract_status = 'REVISION';
          updates.revision_reason = remarks;
        }

        const updated = await tx.masterContract.update({
          where: { contract_id: id },
          data: updates,
        });

        await tx.auditLog.create({
          data: {
            action: `CONTRACT_${action}`,
            module: 'CONFIG',
            entity_type: 'MasterContract',
            entity_id: id,
            old_value: JSON.stringify({ status: existing.contract_status }),
            new_value: JSON.stringify({ status: updated.contract_status }),
            user_email: actor.user_email,
            user_role: actor.user_role,
            reason: remarks,
            ip_address: context?.ipAddress || null,
          },
        });

        await tx.notification.create({
          data: {
            title: action === 'REVISION' ? 'Contract Needs Revision' : 'Contract Approved',
            message:
              action === 'REVISION'
                ? `Master Contract ${id} perlu revisi: ${remarks || '-'}`
                : `Master Contract ${id} telah disetujui`,
            type: action === 'REVISION' ? 'WARNING' : 'INFO',
            module: 'CONFIG',
            reference_type: 'MasterContract',
            reference_id: id,
            target_role: 'ALL',
          },
        });

        return updated;
      });
    } catch (error) {
      throw this.buildReadableError(error, 'Proses approval contract gagal.');
    }
  }

  async list(entity, options) {
    return this.entityRepository.list(entity, options);
  }

  async get(entity, id) {
    const record = await this.entityRepository.get(entity, id);
    if (!record) {
      const error = new Error(`Record ${id} not found in ${entity}`);
      error.statusCode = 404;
      throw error;
    }
    // Support repository returning either { id, payload } or a flattened object with fields
    if (record.payload && typeof record.payload === 'object') {
      return { id: record.id, ...record.payload };
    }
    return record;
  }

  async create(entity, payload, context = {}) {
    const safePayload = entity === 'AuditLog'
      ? this.enforceAuditActor(payload, context)
      : payload;

    const record = await this.entityRepository.create(entity, safePayload);
    if (record && record.payload && typeof record.payload === 'object') {
      return { id: record.id, ...record.payload };
    }
    return record;
  }

  async update(entity, id, payload) {
    let previousDebtor = null;
    if (entity === 'Debtor') {
      previousDebtor = await this.entityRepository.get(entity, id);
    }

    const record = await this.entityRepository.update(entity, id, payload);
    if (!record) {
      const error = new Error(`Unable to update ${entity} ${id}`);
      error.statusCode = 404;
      throw error;
    }

    if (entity === 'Debtor') {
      const relatedBatchIds = new Set();
      if (previousDebtor?.batch_id) relatedBatchIds.add(previousDebtor.batch_id);
      if (record?.batch_id) relatedBatchIds.add(record.batch_id);

      for (const batchId of relatedBatchIds) {
        await this.entityRepository.reconcileBatchAfterDebtorUpdate(batchId, {
          approvedBy:
            payload?.approved_by ||
            payload?.reviewed_by ||
            payload?.validated_by ||
            null,
        });
      }
    }

    if (record.payload && typeof record.payload === 'object') {
      return { id: record.id, ...record.payload };
    }
    return record;
  }

  async delete(entity, id) {
    const record = await this.entityRepository.delete(entity, id);
    if (!record) {
      const error = new Error(`Unable to delete ${entity} ${id}`);
      error.statusCode = 404;
      throw error;
    }
    return { id: record.id };
  }
}
