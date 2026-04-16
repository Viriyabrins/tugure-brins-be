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
      const e = new Error(`Duplicate data. The value on ${target} must be unique.`);
      e.statusCode = 409;
      return e;
    }

    if (error.code === 'P2003') {
      const e = new Error('Data cannot be processed due to an invalid reference relation.');
      e.statusCode = 400;
      return e;
    }

    if (error.code === 'P2025') {
      const e = new Error('The requested data was not found or has already been changed.');
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

  /**
   * Validate raw rows from an uploaded CSV/Excel file for Master Contract.
   * Each row is a plain object with string values as they come from the file parser.
   * Returns an object { valid: boolean, errors: Array<{row, field, value, expected}> }.
   */
  validateMasterContractRawRows(rows = []) {
    const REQUIRED_FIELDS = [
      'underwriter_name', 'input_date', 'input_status', 'contract_status',
      'source_type', 'source_name', 'ceding_name', 'ceding_same_as_source',
      'endorsement_type', 'endorsement_reason', 'endorsement_reason_detail',
      'kind_of_business', 'offer_date', 'contract_no', 'binder_no_tugure',
      'contract_no_from', 'binder_no_from', 'type_of_contract', 'bank_obligee',
      'credit_type', 'product_type', 'product_name',
      'contract_start_date', 'contract_end_date', 'effective_date',
      'outward_retrocession', 'automatic_cession', 'retro_program',
      'reporting_participant_days', 'reporting_claim_days', 'claim_reporting_type',
      'payment_scenario', 'reinsurance_commission_pct',
      'loss_ratio_value', 'loss_ratio_basis',
      'max_tenor_value', 'max_tenor_unit', 'max_sum_insured',
      'limit_coverage_type', 'kolektibilitas_max',
      'qs_tugure_share',
    ];
    const DATE_FIELDS = [
      'input_date', 'offer_date', 'contract_start_date', 'contract_end_date',
      'effective_date', 'stnc_date',
    ];
    const INT_FIELDS = [
      'reporting_participant_days', 'reporting_claim_days',
      'evaluation_period_value', 'max_tenor_value',
      'loss_ratio_value', 'max_sum_insured', 'kolektibilitas_max',
      'qs_tugure_share', 'qs_cedant_share', 'deductible',
    ];
    const DECIMAL_FIELDS = [
      'profit_commission_pct', 'brokerage_fee_pct', 'reinsurance_commission_pct',
      'stop_loss_value', 'cut_loss_value', 'cut_off_value',
      'kolektibilitas_limit_amount',
      'share_tugure_percentage',
    ];
    const BOOLEAN_FIELDS = ['ceding_same_as_source'];

    const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';

    const parseNum = (v) => {
      let s = String(v).trim().replace(/\s/g, '');
      if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
      else if (s.includes(',')) s = s.replace(',', '.');
      const n = Number(s);
      return Number.isNaN(n) ? null : n;
    };

    const BOOLEAN_TRUE = ['true', '1', 'yes', 'y', 'ya'];
    const BOOLEAN_FALSE = ['false', '0', 'no', 'n', 'tidak'];

    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] || {};
      const rowNum = i + 1;

      // Required-field check (empty / null not allowed)
      for (const field of REQUIRED_FIELDS) {
        if (isBlank(row[field])) {
          errors.push({ row: rowNum, field, value: '', expected: 'Required (must not be empty)' });
        }
      }

      for (const field of DATE_FIELDS) {
        const raw = row[field];
        if (isBlank(raw)) continue;
        // Accept Excel numeric serial dates (numbers)
        if (typeof raw === 'number') continue;
        const d = new Date(String(raw).trim());
        if (Number.isNaN(d.getTime())) {
          errors.push({ row: rowNum, field, value: String(raw), expected: 'Date (e.g. YYYY-MM-DD)' });
        }
      }

      for (const field of INT_FIELDS) {
        const raw = row[field];
        if (isBlank(raw)) continue;
        const n = parseNum(raw);
        if (n === null || !Number.isInteger(n)) {
          errors.push({ row: rowNum, field, value: String(raw), expected: 'Integer' });
        }
      }

      for (const field of DECIMAL_FIELDS) {
        const raw = row[field];
        if (isBlank(raw)) continue;
        const n = parseNum(raw);
        if (n === null) {
          errors.push({ row: rowNum, field, value: String(raw), expected: 'Number' });
        }
      }

      for (const field of BOOLEAN_FIELDS) {
        const raw = row[field];
        if (isBlank(raw)) continue;
        if (typeof raw === 'boolean') continue;
        const v = String(raw).trim().toLowerCase();
        if (!BOOLEAN_TRUE.includes(v) && !BOOLEAN_FALSE.includes(v)) {
          errors.push({ row: rowNum, field, value: String(raw), expected: 'Boolean (true/false/yes/no/1/0)' });
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Validate raw normalized rows from an uploaded CSV/Excel file for Debtor.
   * Field names must already be lowercased/alias-resolved (as returned by parseDebtorFile).
   * Returns { valid: boolean, errors: Array<{row, field, value, expected}> }.
   */
  validateDebtorRawRows(rows = []) {
    const DATE_FIELDS = [
      'tanggal_mulai_covering', 'tanggal_akhir_covering',
      'tanggal_terima', 'tanggal_validasi', 'teller_premium_date',
    ];
    const INT_FIELDS = ['status_aktif', 'flag_restruk', 'flag_restruktur', 'kolektabilitas'];
    const DECIMAL_FIELDS = [
      'plafon', 'nominal_premi', 'premi_percentage',
      'premium_amount', 'ric_percentage', 'ric_amount',
      'bf_percentage', 'bf_amount', 'net_premi',
    ];

    const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';

    const parseNum = (v) => {
      let s = String(v).trim().replace(/\s/g, '');
      const lastComma = s.lastIndexOf(',');
      const lastDot = s.lastIndexOf('.');
      if (lastComma > -1 && lastDot > -1) {
        s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
      } else if (lastComma > -1) {
        s = s.replace(',', '.');
      }
      const n = Number.parseFloat(s);
      return Number.isFinite(n) ? n : null;
    };

    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] || {};
      const rowNum = i + 1;

      for (const field of DATE_FIELDS) {
        const raw = row[field];
        if (isBlank(raw)) continue;
        if (raw instanceof Date) continue;
        if (typeof raw === 'number') continue; // Excel serial date
        const d = new Date(String(raw).trim());
        if (Number.isNaN(d.getTime())) {
          errors.push({ row: rowNum, field, value: String(raw), expected: 'Date (e.g. DD/MM/YYYY or YYYY-MM-DD)' });
        }
      }

      for (const field of INT_FIELDS) {
        const raw = row[field];
        if (isBlank(raw)) continue;
        if (typeof raw === 'number') { if (!Number.isInteger(raw)) errors.push({ row: rowNum, field, value: String(raw), expected: 'Integer' }); continue; }
        const n = parseNum(raw);
        if (n === null || !Number.isInteger(n)) {
          errors.push({ row: rowNum, field, value: String(raw), expected: 'Integer' });
        }
      }

      for (const field of DECIMAL_FIELDS) {
        const raw = row[field];
        if (isBlank(raw)) continue;
        if (typeof raw === 'number') continue;
        if (parseNum(raw) === null) {
          errors.push({ row: rowNum, field, value: String(raw), expected: 'Number' });
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Validate parsed claim rows (as returned by parseClaimFile on the frontend).
   * Date fields are stored as raw strings/Date objects; numeric fields are already
   * converted (number or null). Validates date parseability and required numeric fields.
   * Also validates that nomor_peserta + policy_no exist in the debtor table.
   * Returns { valid: boolean, errors: Array<{row, field, value, expected}> }.
   */
  async validateClaimRows(rows = []) {
    const DATE_FIELDS = ['tanggal_realisasi_kredit', 'dol'];
    const REQUIRED_NUMERIC = ['nilai_klaim'];
    const OPTIONAL_NUMERIC = ['plafond', 'max_coverage', 'share_tugure_percentage', 'share_tugure_amount'];

    const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';

    const isValidDate = (v) => {
      if (v instanceof Date) return !Number.isNaN(v.getTime());
      if (typeof v === 'number') return true; // Excel serial
      const d = new Date(String(v).trim());
      return !Number.isNaN(d.getTime());
    };

    const errors = [];

    // Build a set of valid (policy_no, nomor_peserta) pairs from ALL debtors
    let validDebtorPairs = new Set();
    try {
      const allDebtors = await prisma.debtor.findMany({
        select: { policy_no: true, nomor_peserta: true },
      });

      for (const debtor of allDebtors) {
        const key = `${String(debtor.policy_no || '').trim().toLowerCase()}||${String(debtor.nomor_peserta || '').trim().toLowerCase()}`;
        validDebtorPairs.add(key);
      }
    } catch (err) {
      console.error('Error fetching debtors for validation:', err);
      // Don't block validation if debtor fetch fails - treat as warning
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] || {};
      const rowNum = row.excelRow || i + 2;

      // Validate date fields
      for (const field of DATE_FIELDS) {
        const raw = row[field];
        if (isBlank(raw)) continue;
        if (!isValidDate(raw)) {
          errors.push({ row: rowNum, field, value: String(raw), expected: 'Date (e.g. YYYY-MM-DD)' });
        }
      }

      // Validate required numeric fields
      for (const field of REQUIRED_NUMERIC) {
        const val = row[field];
        if (val === null || val === undefined || (typeof val !== 'number') || !Number.isFinite(val)) {
          errors.push({ row: rowNum, field, value: String(val ?? ''), expected: 'Valid number (required)' });
        }
      }

      // Validate optional numeric fields
      for (const field of OPTIONAL_NUMERIC) {
        const val = row[field];
        if (val === null || val === undefined) continue;
        if (typeof val !== 'number' || !Number.isFinite(val)) {
          errors.push({ row: rowNum, field, value: String(val), expected: 'Number' });
        }
      }

      // Validate debtor exists in debtor table
      if (validDebtorPairs.size > 0) {
        const claimKey = `${String(row.policy_no || '').trim().toLowerCase()}||${String(row.nomor_peserta || '').trim().toLowerCase()}`;
        if (!validDebtorPairs.has(claimKey)) {
          errors.push({
            row: rowNum,
            field: 'nomor_peserta + policy_no',
            value: `policy_no=${row.policy_no}, nomor_peserta=${row.nomor_peserta}`,
            expected: 'Must exist in debtors',
          });
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Validate a subrogation form payload before saving.
   * Returns { valid: boolean, errors: Array<{field, value, expected}> }.
   */
  validateSubrogationPayload(payload = {}) {
    const errors = [];

    const amt = payload.recoveryAmount;
    const numAmt = typeof amt === 'number' ? amt : Number(String(amt ?? '').replace(/[^0-9.-]/g, ''));
    if (!Number.isFinite(numAmt) || numAmt <= 0) {
      errors.push({ field: 'recoveryAmount', value: String(amt ?? ''), expected: 'Positive number' });
    }

    const dt = payload.recoveryDate;
    if (!dt || String(dt).trim() === '') {
      errors.push({ field: 'recoveryDate', value: '', expected: 'Date (YYYY-MM-DD)' });
    } else {
      const d = new Date(String(dt).trim());
      if (Number.isNaN(d.getTime())) {
        errors.push({ field: 'recoveryDate', value: String(dt), expected: 'Date (YYYY-MM-DD)' });
      }
    }

    return { valid: errors.length === 0, errors };
  }

  async uploadMasterContractsAtomic(payload = {}, context = {}) {
    const contracts = Array.isArray(payload.contracts) ? payload.contracts : [];
    const uploadMode = String(payload.uploadMode || 'new').toLowerCase();
    const selectedContractForRevision = payload.selectedContractForRevision || null;
    const selectedRevisionValue = String(selectedContractForRevision || '').trim();
    const actor = this.resolveAuditActor(context);

    if (contracts.length === 0) {
      const error = new Error('Upload file is empty. No contract data to process.');
      error.statusCode = 400;
      throw error;
    }

    if (uploadMode === 'revise' && !selectedRevisionValue) {
      const error = new Error('Revise mode requires a contract to be selected.');
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
        const error = new Error('Some rows are missing a valid contract_id. Please check the upload template.');
        error.statusCode = 400;
        throw error;
      }

      const duplicateInFile = contractIds.find((id, index) => contractIds.indexOf(id) !== index);
      if (duplicateInFile) {
        const error = new Error(`Duplicate contract_id found in upload file: ${duplicateInFile}`);
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
        const error = new Error(`Upload cancelled: contract_id already registered: ${existsList}`);
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
        const error = new Error('The selected contract for revision was not found by contract_id or contract_no.');
        error.statusCode = 404;
        throw error;
      }

      const status = String(revisionBaseContract.contract_status || '').trim().toUpperCase();
      if (status !== 'REVISION') {
        const error = new Error('Only contracts with status REVISION can be revised.');
        error.statusCode = 400;
        throw error;
      }

      revisionContractNo = String(revisionBaseContract.contract_no || '').trim();
      if (!revisionContractNo) {
        const error = new Error('The revision contract does not have a contract_no as reference.');
        error.statusCode = 400;
        throw error;
      }

      const revisionContractBase = (String(revisionContractNo).match(/^(.*?)(?:_V\d+_.*)?$/i) || [revisionContractNo])[1];

      for (let i = 0; i < contracts.length; i += 1) {
        const incomingContractNo = String(contracts[i]?.contract_no || '').trim();
        if (!incomingContractNo) {
          const error = new Error(`Row ${i + 1}: contract_no is required and must match the revised contract (${revisionContractBase}).`);
          error.statusCode = 400;
          throw error;
        }
        const incomingBase = (String(incomingContractNo).match(/^(.*?)(?:_V\d+_.*)?$/i) || [incomingContractNo])[1];
        if (incomingBase !== revisionContractBase) {
          const error = new Error(`Row ${i + 1}: contract_no must match the revised contract (${revisionContractBase}).`);
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

          // Set uploaded_by and uploaded_date for all contracts (both new and revise modes)
          row.uploaded_by = actor.user_email;
          row.uploaded_date = new Date();

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
            message: `${createdContracts.length} master contract(s) uploaded successfully (${uploadMode}).`,
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
      throw this.buildReadableError(error, 'Master contract upload failed to process.');
    }
  }

  async processMasterContractApprovalAtomic(contractId, payload = {}, context = {}) {
    const id = String(contractId || '').trim();
    const action = String(payload.action || '').trim().toUpperCase();
    const remarks = payload.remarks ? String(payload.remarks) : null;
    const actor = this.resolveAuditActor(context);

    if (!id) {
      const error = new Error('Contract ID is required.');
      error.statusCode = 400;
      throw error;
    }

    if (!['APPROVED', 'REVISION'].includes(action)) {
      const error = new Error('Invalid approval action. Use APPROVED or REVISION.');
      error.statusCode = 400;
      throw error;
    }

    try {
      return await prisma.$transaction(async (tx) => {
        const existing = await tx.masterContract.findUnique({ where: { contract_id: id } });
        if (!existing) {
          const error = new Error(`Master Contract ${id} not found.`);
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
                ? `Master Contract ${id} needs revision: ${remarks || '-'}`
                : `Master Contract ${id} has been approved`,
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
      throw this.buildReadableError(error, 'Contract approval process failed.');
    }
  }

  /**
   * Handle any MC workflow transition.
   * Actions: CHECK_BRINS, APPROVE_BRINS, CHECK_TUGURE, APPROVE, REVISION
   * Updates status_approval and stores actor email in the appropriate DB field.
   * Fires WorkflowEmailService (fire-and-forget) after the transaction.
   */
  async processMasterContractWorkflowActionAtomic(contractId, payload = {}, context = {}) {
    const id = String(contractId || '').trim();
    const action = String(payload.action || '').trim().toUpperCase();
    const remarks = payload.remarks ? String(payload.remarks) : null;
    const actor = this.resolveAuditActor(context);

    if (!id) {
      const error = new Error('Contract ID is required.');
      error.statusCode = 400;
      throw error;
    }

    const VALID_ACTIONS = ['CHECK_BRINS', 'APPROVE_BRINS', 'CHECK_TUGURE', 'APPROVE', 'REVISION'];
    if (!VALID_ACTIONS.includes(action)) {
      const error = new Error(`Invalid action. Must be one of: ${VALID_ACTIONS.join(', ')}`);
      error.statusCode = 400;
      throw error;
    }

    // Status transition map: { action → { expectedCurrentStatus, newStatus } }
    const TRANSITIONS = {
      CHECK_BRINS:  { from: ['SUBMITTED', 'Draft'],    to: 'CHECKED_BRINS' },
      APPROVE_BRINS:{ from: ['CHECKED_BRINS'],          to: 'APPROVED_BRINS' },
      CHECK_TUGURE: { from: ['APPROVED_BRINS'],          to: 'CHECKED_TUGURE' },
      APPROVE:      { from: ['CHECKED_TUGURE'],          to: 'APPROVED' },
      REVISION:     { from: ['CHECKED_BRINS', 'CHECKED_TUGURE'], to: 'REVISION' },
    };

    try {
      const updated = await prisma.$transaction(async (tx) => {
        const existing = await tx.masterContract.findUnique({ where: { contract_id: id } });
        if (!existing) {
          const error = new Error(`Master Contract ${id} not found.`);
          error.statusCode = 404;
          throw error;
        }

        const transition = TRANSITIONS[action];
        const currentStatus = existing.status_approval || 'SUBMITTED';
        if (!transition.from.includes(currentStatus)) {
          const error = new Error(`Cannot perform ${action}: contract is in ${currentStatus} status, expected ${transition.from.join(' or ')}.`);
          error.statusCode = 400;
          throw error;
        }

        // Build update data
        const updates = { status_approval: transition.to };
        const now = new Date();
        if (action === 'CHECK_BRINS') {
          updates.checked_by_brins = actor.user_email;
          updates.checked_date_brins = now;
        } else if (action === 'APPROVE_BRINS') {
          updates.first_approved_by = actor.user_email;
          updates.first_approved_date = now;
          if (remarks) updates.remark = remarks;
        } else if (action === 'CHECK_TUGURE') {
          updates.checked_by_tugure = actor.user_email;
          updates.checked_date_tugure = now;
        } else if (action === 'APPROVE') {
          updates.second_approved_by = actor.user_email;
          updates.second_approved_date = now;
          if (remarks) updates.remark = remarks;
        } else if (action === 'REVISION') {
          updates.contract_status = 'REVISION';
          updates.revision_reason = remarks;
        }

        const contract = await tx.masterContract.update({
          where: { contract_id: id },
          data: updates,
        });

        await tx.auditLog.create({
          data: {
            action: `CONTRACT_${action}`,
            module: 'CONFIG',
            entity_type: 'MasterContract',
            entity_id: id,
            old_value: JSON.stringify({ status_approval: currentStatus }),
            new_value: JSON.stringify({ status_approval: transition.to }),
            user_email: actor.user_email,
            user_role: actor.user_role,
            reason: remarks,
            ip_address: context?.ipAddress || null,
          },
        });

        await tx.notification.create({
          data: {
            title: action === 'REVISION' ? 'Contract Needs Revision' : `Contract ${action.replace('_', ' ')}`,
            message: action === 'REVISION'
              ? `Master Contract ${id} needs revision: ${remarks || '-'}`
              : `Master Contract ${id} status updated to ${transition.to}`,
            type: action === 'REVISION' ? 'WARNING' : 'INFO',
            module: 'CONFIG',
            reference_type: 'MasterContract',
            reference_id: id,
            target_role: 'ALL',
          },
        });

        return contract;
      });

      // Fire-and-forget emails after transaction succeeds (lazy import to avoid circular deps)
      Promise.resolve().then(async () => {
        try {
          const { default: WorkflowEmailService } = await import('./WorkflowEmailService.js');
          const contract = updated;
          const ctx = {
            actorEmail: actor.user_email,
            uploaderEmail: contract.uploaded_by,
            checkerEmail: contract.checked_by_brins,
            checkerBrinsEmail: contract.checked_by_brins,
            approverBrinsEmail: contract.first_approved_by,
            checkerTugureEmail: contract.checked_by_tugure,
            batchId: id,
            module: 'MC',
            remarks,
          };
          if (action === 'CHECK_BRINS')   WorkflowEmailService.sendCheckBrinsEmail(ctx);
          else if (action === 'APPROVE_BRINS') WorkflowEmailService.sendApproveBrinsEmail(ctx);
          else if (action === 'CHECK_TUGURE')  WorkflowEmailService.sendCheckTugureEmail(ctx);
          else if (action === 'APPROVE')       WorkflowEmailService.sendApproveFinalEmail(ctx);
          else if (action === 'REVISION')      WorkflowEmailService.sendRevisionEmail({ uploaderEmail: contract.uploaded_by, batchId: id, module: 'MC', remarks });
        } catch (emailErr) {
          console.warn('[EntityService] MC workflow email dispatch failed:', emailErr.message);
        }
      });

      return updated;
    } catch (error) {
      throw this.buildReadableError(error, 'Master contract workflow action failed.');
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

  async update(entity, id, payload, context = {}) {
    // For Nota updates, validate BRINS roles only
    if (entity === 'Nota') {
      const userRoles = context?.user?.application_roles || [];
      const isBrinsRole = userRoles.some(r => {
        const normalizedRole = String(r).trim().toLowerCase();
        return ['approver-brins-role', 'checker-brins-role', 'maker-brins-role'].includes(normalizedRole);
      });
      
      if (!isBrinsRole) {
        const error = new Error('Only BRINS roles can update Nota status');
        error.statusCode = 403;
        throw error;
      }
    }

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

  /**
   * Detect duplicates within a set of normalized debtor rows
   * Returns array of duplicate groups { field, value, rowIndices }
   */
  detectFileDuplicates(rows = []) {
    const fileDuplicates = [];
    const seenByNomorPeserta = {};
    const seenByPolicyNo = {};

    rows.forEach((row, idx) => {
      const np = row.nomor_peserta
        ? String(row.nomor_peserta).trim()
        : null;
      const pn = row.policy_no
        ? String(row.policy_no).trim()
        : null;

      // Track nomor_peserta
      if (np) {
        if (seenByNomorPeserta[np]) {
          seenByNomorPeserta[np].push(idx);
        } else {
          seenByNomorPeserta[np] = [idx];
        }
      }

      // Track policy_no (can be null)
      if (pn) {
        if (seenByPolicyNo[pn]) {
          seenByPolicyNo[pn].push(idx);
        } else {
          seenByPolicyNo[pn] = [idx];
        }
      }
    });

    // Build duplicates array (only groups with 2+ rows)
    Object.entries(seenByNomorPeserta).forEach(([value, indices]) => {
      if (indices.length > 1) {
        fileDuplicates.push({
          field: 'nomor_peserta',
          value,
          rowIndices: indices,
        });
      }
    });

    Object.entries(seenByPolicyNo).forEach(([value, indices]) => {
      if (indices.length > 1) {
        fileDuplicates.push({
          field: 'policy_no',
          value,
          rowIndices: indices,
        });
      }
    });

    return fileDuplicates;
  }

  /**
   * Check if any nomor_peserta or policy_no values already exist in database
   * Returns array of database conflicts { field, rowIndex, value, existingRecord }
   */
  async checkDatabaseDuplicates(rows = []) {
    const databaseDuplicates = [];

    // Extract unique values to check
    const nomorPesertaValues = [];
    const policyNoValues = [];

    const rowMap = {}; // Maps nomor_peserta/policy_no to row indices

    rows.forEach((row, idx) => {
      const np = row.nomor_peserta
        ? String(row.nomor_peserta).trim()
        : null;
      const pn = row.policy_no
        ? String(row.policy_no).trim()
        : null;

      if (np) {
        nomorPesertaValues.push(np);
        if (!rowMap[`np:${np}`]) {
          rowMap[`np:${np}`] = [];
        }
        rowMap[`np:${np}`].push(idx);
      }

      if (pn) {
        policyNoValues.push(pn);
        if (!rowMap[`pn:${pn}`]) {
          rowMap[`pn:${pn}`] = [];
        }
        rowMap[`pn:${pn}`].push(idx);
      }
    });

    if (nomorPesertaValues.length === 0 && policyNoValues.length === 0) {
      return databaseDuplicates;
    }

    // Query database for existing records
    const existingRecords = await prisma.debtor.findMany({
      where: {
        OR: [
          nomorPesertaValues.length > 0
            ? { nomor_peserta: { in: nomorPesertaValues } }
            : { nomor_peserta: null }, // Match nothing if no values
          policyNoValues.length > 0
            ? { policy_no: { in: policyNoValues } }
            : { policy_no: null }, // Match nothing if no values
        ],
      },
      select: {
        id: true,
        nomor_peserta: true,
        policy_no: true,
        status: true,
        version_no: true,
        batch_id: true,
      },
    });

    // Build conflicts array
    rows.forEach((row, rowIdx) => {
      const np = row.nomor_peserta
        ? String(row.nomor_peserta).trim()
        : null;
      const pn = row.policy_no
        ? String(row.policy_no).trim()
        : null;

      // Check for nomor_peserta match
      if (np) {
        const existingByNP = existingRecords.find(
          (r) => r.nomor_peserta === np
        );
        if (existingByNP) {
          databaseDuplicates.push({
            field: 'nomor_peserta',
            rowIndex: rowIdx,
            value: np,
            existingRecord: existingByNP,
          });
        }
      }

      // Check for policy_no match (only if policy_no is not null)
      if (pn) {
        const existingByPN = existingRecords.find(
          (r) => r.policy_no === pn
        );
        if (existingByPN) {
          databaseDuplicates.push({
            field: 'policy_no',
            rowIndex: rowIdx,
            value: pn,
            existingRecord: existingByPN,
          });
        }
      }
    });

    return databaseDuplicates;
  }

  /**
   * Check for both file-level and database-level duplicates
   * Used during preview generation to detect conflicts before upload
   */
  async checkUploadDuplicates(rows = []) {
    const fileDuplicates = this.detectFileDuplicates(rows);
    const databaseDuplicates = await this.checkDatabaseDuplicates(rows);

    return {
      fileDuplicates,
      databaseDuplicates,
    };
  }

  async uploadDebtorsAtomic(payload = {}, context = {}) {
    const debtors = Array.isArray(payload.debtors) ? payload.debtors : [];
    const uploadMode = String(payload.uploadMode || 'new').toLowerCase();
    const selectedDebtorForRevision = payload.selectedDebtorForRevision || null;
    const selectedRevisionValue = String(selectedDebtorForRevision || '').trim();
    const actor = this.resolveAuditActor(context);

    if (debtors.length === 0) {
      const error = new Error('Upload file is empty. No debtor data to process.');
      error.statusCode = 400;
      throw error;
    }

    if (uploadMode === 'revise' && !selectedRevisionValue) {
      const error = new Error('Revise mode requires a debtor to be selected.');
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
        const error = new Error('Some rows are missing a valid nomor_peserta. Please check the upload template.');
        error.statusCode = 400;
        throw error;
      }

      // Check for duplicates in file
      const duplicateInFile = nomorPesertas.find((np, index) => nomorPesertas.indexOf(np) !== index);
      if (duplicateInFile) {
        const error = new Error(`Duplicate nomor_peserta found in upload file: ${duplicateInFile}`);
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
        const error = new Error(`Upload cancelled: nomor_peserta already registered: ${existsList}`);
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
        const error = new Error(`None of the uploaded debtors have REVISION status in the system.`);
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
              const error = new Error(`Debtor with nomor_peserta "${nomorPeserta}" was not found or does not have REVISION status.`);
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

        // Aggregate premium values and update the Batch
        if (createdDebtors.length > 0) {
          let batchPremium = 0;
          let batchCommission = 0;
          for (const d of createdDebtors) {
            batchPremium += parseFloat(d.premium_amount) || 0;
            batchCommission += parseFloat(d.ric_amount) || 0;
          }
          const batchTotal = batchPremium - batchCommission;
          const batchClaim = 0;
          const batchNetDue = batchTotal - batchClaim;

          // Group created debtors by batch_id to update each batch
          const batchIds = [...new Set(createdDebtors.map((d) => d.batch_id).filter(Boolean))];
          for (const bid of batchIds) {
            const batchDebtors = createdDebtors.filter((d) => d.batch_id === bid);
            let bp = 0;
            let bc = 0;
            for (const d of batchDebtors) {
              bp += parseFloat(d.premium_amount) || 0;
              bc += parseFloat(d.ric_amount) || 0;
            }
            const bt = bp - bc;
            const bnd = bt - 0; // claim = 0
            await tx.batch.update({
              where: { batch_id: bid },
              data: {
                premium: bp,
                commission: bc,
                claim: 0,
                total: bt,
                net_due: bnd,
                uploaded_by: actor.user_email,
                uploaded_date: new Date(),
              },
            });
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
            message: `${createdDebtors.length} debtor(s) uploaded successfully (${uploadMode}).`,
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
      throw this.buildReadableError(error, 'Debtor upload failed to process.');
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
