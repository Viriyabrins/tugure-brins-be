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
    // Holds full records of REVISION-status contracts found during 'new' mode upload
    // so they can be archived to ContractRevise inside the transaction.
    let revisionContractsToArchive = [];

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
        select: { contract_id: true, contract_status: true },
      });

      // Only reject contract_ids that are NOT in REVISION status.
      // Contracts in REVISION status will be archived and replaced by the new upload.
      const nonRevisionConflicts = existing.filter(
        (item) => String(item.contract_status || '').trim().toUpperCase() !== 'REVISION'
      );

      if (nonRevisionConflicts.length > 0) {
        const existsList = nonRevisionConflicts.map((item) => item.contract_id).join(', ');
        const error = new Error(`Upload dibatalkan karena contract_id sudah terdaftar: ${existsList}`);
        error.statusCode = 409;
        throw error;
      }

      // Fetch full data of REVISION contracts so we can archive them inside the transaction.
      const revisionIds = existing
        .filter((item) => String(item.contract_status || '').trim().toUpperCase() === 'REVISION')
        .map((item) => item.contract_id);

      if (revisionIds.length > 0) {
        revisionContractsToArchive = await prisma.masterContract.findMany({
          where: { contract_id: { in: revisionIds } },
        });
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

      const revisionContractBase = (String(revisionContractNo).match(/^(.*?)(?:_V\d+_.*)?$/i) || [revisionContractNo])[1];

      for (let i = 0; i < contracts.length; i += 1) {
        const incomingContractNo = String(contracts[i]?.contract_no || '').trim();
        if (!incomingContractNo) {
          const error = new Error(`Baris ke-${i + 1}: contract_no wajib diisi dan harus sama dengan kontrak yang direvisi (${revisionContractBase}).`);
          error.statusCode = 400;
          throw error;
        }
        const incomingBase = (String(incomingContractNo).match(/^(.*?)(?:_V\d+_.*)?$/i) || [incomingContractNo])[1];
        if (incomingBase !== revisionContractBase) {
          const error = new Error(`Baris ke-${i + 1}: contract_no harus sama dengan kontrak yang direvisi (${revisionContractBase}).`);
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

        const getJakartaTimestamp = () => {
          const dt = new Date();
          const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Asia/Jakarta',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
          }).formatToParts(dt);
          const map = {};
          parts.forEach((p) => {
            if (p.type !== 'literal') map[p.type] = p.value;
          });
          return `${map.year}${map.month}${map.day}${map.hour}${map.minute}${map.second}`;
        };

        const extractBaseContractNo = (cn) => {
          if (!cn) return '';
          const m = String(cn).match(/^(.*?)(?:_V\d+_.*)?$/i);
          return m ? m[1] : String(cn);
        };

        if (uploadMode === 'revise') {
          const baseContractNoForSearch = extractBaseContractNo(revisionContractNo || revisionBaseContract.contract_no || '');
          const versionRows = await tx.masterContract.findMany({
            where: { contract_no: { startsWith: baseContractNoForSearch } },
            select: { version: true },
          });

          const maxVersion = versionRows.reduce((max, row) => {
            const current = Number(row?.version);
            if (Number.isFinite(current)) return Math.max(max, current);
            return max;
          }, 0);

          revisionVersionStart = maxVersion + 1;

          const { ...archivedRevisionPayload } = revisionBaseContract;
          await tx.contractRevise.upsert({
            where: { contract_id: archivedRevisionPayload.contract_id },
            create: { ...archivedRevisionPayload, contract_status: 'REVISION' },
            update: { ...archivedRevisionPayload, contract_status: 'REVISION' },
          });

          await tx.masterContract.delete({
            where: { contract_id: revisionBaseContract.contract_id },
          });
        }

        // For 'new' mode: archive any REVISION contracts whose contract_id appears in the upload,
        // then delete them so the new data can be inserted with the same contract_id.
        if (uploadMode === 'new' && revisionContractsToArchive.length > 0) {
          for (const archiveContract of revisionContractsToArchive) {
            const { ...archivePayload } = archiveContract;
            await tx.contractRevise.upsert({
              where: { contract_id: archivePayload.contract_id },
              create: { ...archivePayload, contract_status: 'REVISION' },
              update: { ...archivePayload, contract_status: 'REVISION' },
            });
            await tx.masterContract.delete({
              where: { contract_id: archiveContract.contract_id },
            });
          }
        }

        for (let i = 0; i < contracts.length; i += 1) {
          const row = { ...(contracts[i] || {}) };

          if (uploadMode === 'revise') {
            const nextVersion = revisionVersionStart + i;
            const baseId = sanitizeIdPart(revisionBaseContract.contract_id || revisionContractNo || 'MC');
            const candidateId = `${baseId}-REV-${String(nextVersion).padStart(3, '0')}`;

            const baseContractNo = extractBaseContractNo(revisionContractNo || revisionBaseContract.contract_no || revisionBaseContract.contract_no_from || 'MC');
            const timestamp = getJakartaTimestamp();

            row.contract_id = candidateId;
            row.version = nextVersion;
            row.parent_contract_id = revisionBaseContract.contract_id;
            row.contract_status = row.contract_status || 'Draft';
            row.contract_no_from = baseContractNo;
            row.contract_no = `${baseContractNo}_V${nextVersion}_${timestamp}`;
          } else {
            // new upload mode: assign initial versioning V1 with Jakarta timestamp
            const incomingBase = extractBaseContractNo(row.contract_no || row.contract_id || 'MC');
            const baseContractNo = incomingBase || sanitizeIdPart(row.contract_id || 'MC');
            const timestamp = getJakartaTimestamp();
            row.version = 1;
            row.contract_no_from = baseContractNo;
            row.contract_no = `${baseContractNo}_V1_${timestamp}`;
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

  async uploadDebtorsAtomic(payload = {}, context = {}) {
    const debtors = Array.isArray(payload.debtors) ? payload.debtors : [];
    const uploadMode = String(payload.uploadMode || 'new').toLowerCase();
    const selectedDebtorForRevision = payload.selectedDebtorForRevision || null;
    const selectedRevisionValue = String(selectedDebtorForRevision || '').trim();
    const actor = this.resolveAuditActor(context);

    if (debtors.length === 0) {
      const error = new Error('File upload kosong. Tidak ada data debtor yang bisa diproses.');
      error.statusCode = 400;
      throw error;
    }

    if (uploadMode === 'revise' && !selectedRevisionValue) {
      const error = new Error('Mode revisi membutuhkan debtor yang dipilih.');
      error.statusCode = 400;
      throw error;
    }

    let revisionBaseDebtor = null;
    let revisionNomorPeserta = null;
    let revisionDebtorsToArchive = [];
    let revisionDebtorMap = null;
    let nextVersionMap = null;  // For pre-calculated versions in revision mode

    if (uploadMode === 'new') {
      // Validate that all debtors have nomor_peserta
      const nomorPesertas = debtors
        .map((item) => String(item?.nomor_peserta || '').trim())
        .filter(Boolean);

      if (nomorPesertas.length !== debtors.length) {
        const error = new Error('Sebagian baris tidak memiliki nomor_peserta yang valid. Periksa kembali template upload.');
        error.statusCode = 400;
        throw error;
      }

      // Check for duplicates in file
      const duplicateInFile = nomorPesertas.find((np, index) => nomorPesertas.indexOf(np) !== index);
      if (duplicateInFile) {
        const error = new Error(`Terdapat nomor_peserta duplikat di file upload: ${duplicateInFile}`);
        error.statusCode = 400;
        throw error;
      }

      const existing = await prisma.debtor.findMany({
        where: { nomor_peserta: { in: nomorPesertas } },
        select: { 
          id: true,
          nomor_peserta: true, 
          status: true,
          batch_id: true,
          contract_id: true,
        },
      });

      // Only reject nomor_peserta that are NOT in REVISION status
      const nonRevisionConflicts = existing.filter(
        (item) => String(item.status || '').trim().toUpperCase() !== 'REVISION'
      );

      if (nonRevisionConflicts.length > 0) {
        const existsList = nonRevisionConflicts.map((item) => item.nomor_peserta).join(', ');
        const error = new Error(`Upload dibatalkan karena nomor_peserta sudah terdaftar: ${existsList}`);
        error.statusCode = 409;
        throw error;
      }

      // Fetch full data of REVISION debtors to archive them
      const revisionIds = existing
        .filter((item) => String(item.status || '').trim().toUpperCase() === 'REVISION')
        .map((item) => item.id);

      if (revisionIds.length > 0) {
        revisionDebtorsToArchive = await prisma.debtor.findMany({
          where: { id: { in: revisionIds } },
        });
      }

      // Initialize empty revisionDebtorMap for 'new' mode (not needed but keep for consistency)
      revisionDebtorMap = new Map();
    } else {
      // Revise mode: process each debtor individually
      // Extract all unique nomor_peserta from uploaded debtors
      const uploadedNomorPesertas = Array.from(
        new Set(
          debtors
            .map((item) => String(item?.nomor_peserta || '').trim())
            .filter(Boolean)
        )
      );

      if (uploadedNomorPesertas.length === 0) {
        const error = new Error('Mode revisi membutuhkan nomor_peserta dalam data yang diupload.');
        error.statusCode = 400;
        throw error;
      }

      // For revise mode, find existing REVISION debtors for ALL uploaded nomor_peserta
      // We'll handle each one separately during the transaction
      const existingRevisionDebtors = await prisma.debtor.findMany({
        where: {
          nomor_peserta: { in: uploadedNomorPesertas },
          status: {
            equals: 'REVISION',
            mode: 'insensitive',
          },
        },
      });

      // Create a map of nomor_peserta -> existing revision debtor for quick lookup
      revisionDebtorMap = new Map(
        existingRevisionDebtors.map((d) => [d.nomor_peserta, d])
      );

      // Filter to only process debtors with REVISION status
      // This allows user to upload a full batch file but only revise the ones marked REVISION
      const revisionableNomorPesertas = Array.from(revisionDebtorMap.keys());
      
      if (revisionableNomorPesertas.length === 0) {
        const error = new Error(`Tidak ada debtor dalam data upload yang memiliki status REVISION di sistem.`);
        error.statusCode = 404;
        throw error;
      }

      // Filter the debtors array to only those with REVISION status
      // This silently ignores debtors that are not marked for revision
      const filteredDebtors = debtors.filter((d) => {
        const nomorPeserta = String(d?.nomor_peserta || '').trim();
        return revisionDebtorMap.has(nomorPeserta);
      });

      // Use filtered debtors for the transaction by removing non-revision debtors
      // We'll reconstruct the debtors array to include only those being revised
      while (debtors.length > 0) {
        debtors.pop();
      }
      filteredDebtors.forEach((d) => debtors.push(d));

      // Store for logging
      revisionNomorPeserta = revisionableNomorPesertas.join(', ');

      // PRE-CALCULATE NEXT VERSION NUMBERS FOR EACH nomor_peserta
      // Query both Debtor and DebtorRevise tables to find max version
      nextVersionMap = new Map();

      for (const nomorPeserta of revisionableNomorPesertas) {
        // Find max version from Debtor table (current records)
        const debtorVersions = await prisma.debtor.findMany({
          where: { nomor_peserta: nomorPeserta },
          select: { version_no: true },
        });

        // Find max version from DebtorRevise table (archived records)
        const reviseVersions = await prisma.debtorRevise.findMany({
          where: { nomor_peserta: nomorPeserta },
          select: { version_no: true },
        });

        // Get max from all versions
        const allVersions = [
          ...debtorVersions.map((d) => Number(d?.version_no || 0)),
          ...reviseVersions.map((d) => Number(d?.version_no || 0)),
        ];

        const maxVersion = allVersions.reduce((max, v) => {
          if (Number.isFinite(v)) return Math.max(max, v);
          return max;
        }, 0);

        nextVersionMap.set(nomorPeserta, maxVersion + 1);
      }
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        const createdDebtors = [];
        
        // For 'new' mode: archive any REVISION debtors whose nomor_peserta appears in upload
        if (uploadMode === 'new' && revisionDebtorsToArchive.length > 0) {
          for (const archiveDebtor of revisionDebtorsToArchive) {
            const { ...archivePayload } = archiveDebtor;
            await tx.debtorRevise.create({ 
              data: { 
                ...archivePayload, 
                status: 'REVISION',
                archived_at: new Date(),
              } 
            });
            await tx.debtor.delete({
              where: { id: archiveDebtor.id },
            });
          }
        }

        // Track version_no per nomor_peserta for revision mode
        // Build a map: nomor_peserta -> next version number
        const versionMapByNomorPeserta = new Map();

        // Create new debtors with versioning
        for (let i = 0; i < debtors.length; i += 1) {
          const row = { ...(debtors[i] || {}) };

          if (uploadMode === 'revise') {
            const nomorPeserta = String(row?.nomor_peserta || '').trim();
            
            // Get the existing REVISION debtor for this nomor_peserta
            const revisionDebtor = revisionDebtorMap.get(nomorPeserta);
            if (!revisionDebtor) {
              // This should already be caught in validation, but double-check
              const error = new Error(`Debtor dengan nomor_peserta "${nomorPeserta}" tidak ditemukan atau tidak berstatus REVISION.`);
              error.statusCode = 404;
              throw error;
            }

            // Archive old REVISION debtor to DebtorRevise
            const { ...archivedPayload } = revisionDebtor;
            await tx.debtorRevise.create({ 
              data: { 
                ...archivedPayload, 
                status: 'REVISION',
                archived_at: new Date(),
              } 
            });

            // Delete old debtor
            await tx.debtor.delete({
              where: { id: revisionDebtor.id },
            });

            // Use pre-calculated next version for this nomor_peserta
            const nextVersion = nextVersionMap.get(nomorPeserta) || 1;

            // Set versioning fields
            row.version_no = nextVersion;
            row.parent_debtor_id = revisionDebtor.id;
            row.status = row.status || 'SUBMITTED';

            // Update map for tracking if same nomor_peserta appears multiple times in upload
            const currentCount = versionMapByNomorPeserta.get(nomorPeserta) || 0;
            versionMapByNomorPeserta.set(nomorPeserta, currentCount + 1);
          } else {
            // 'new' mode versioning
            row.version_no = 1;
            row.parent_debtor_id = null;
          }

          try {
            const created = await tx.debtor.create({ data: row });
            createdDebtors.push(created);
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

        // Create audit log
        await tx.auditLog.create({
          data: {
            action: uploadMode === 'revise' ? 'DEBTOR_REVISED_BULK' : 'DEBTOR_UPLOADED_BULK',
            module: 'DEBTOR',
            entity_type: 'Debtor',
            entity_id: createdDebtors.map((item) => item.id).join(', '),
            old_value: null,
            new_value: JSON.stringify({
              upload_mode: uploadMode,
              total_uploaded: createdDebtors.length,
              debtor_ids: createdDebtors.map((item) => item.id),
            }),
            user_email: actor.user_email,
            user_role: actor.user_role,
            reason: uploadMode === 'revise'
              ? `Bulk revise upload for debtor ${selectedDebtorForRevision} (${revisionNomorPeserta})`
              : 'Bulk upload from Submit Debtor',
            ip_address: context?.ipAddress || null,
          },
        });

        // Create notification
        await tx.notification.create({
          data: {
            title: uploadMode === 'revise' ? 'Debtor Revision Uploaded' : 'Debtor Uploaded',
            message: `${createdDebtors.length} debtor berhasil di-upload (${uploadMode}).`,
            type: 'INFO',
            module: 'DEBTOR',
            reference_type: 'Debtor',
            reference_id: createdDebtors[0]?.id || null,
            target_role: 'ALL',
          },
        });

        return {
          createdCount: createdDebtors.length,
          debtors: createdDebtors,
        };
      });

      return result;
    } catch (error) {
      throw this.buildReadableError(error, 'Upload debtor gagal diproses.');
    }
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
