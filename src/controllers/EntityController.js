import { sendSuccess, sendCreated, sendError } from '../utils/response.js';
import { paginate, paginationResponse } from '../utils/pagination.js';
import * as jobQueue from '../utils/jobQueue.js';
import * as DebtorService from '../services/DebtorService.js';
import * as ClaimService from '../services/ClaimService.js';
import prisma from '../prisma/client.js';
import { NotificationRepository } from '../repositories/NotificationRepository.js';
import * as WorkflowEmailService from '../services/WorkflowEmailService.js';
import * as NotaService from '../services/NotaService.js';

const ALL_ROLES = ['maker-brins-role', 'checker-brins-role', 'approver-brins-role', 'checker-tugure-role', 'approver-tugure-role'];

export default class EntityController {
  constructor({ entityService }) {
    this.entityService = entityService;
  }

  async list(request, reply) {
    try {
      const { page, limit, offset } = paginate(request.query);
      // support optional JSON filter in `q` query param (frontend may send q=JSON.stringify(filters))
      let parsedFilters = undefined;
      if (request.query && request.query.q) {
        try {
          parsedFilters = JSON.parse(request.query.q);
        } catch (e) {
          // ignore parse errors and treat as no filters
          parsedFilters = undefined;
        }
      }

      const params = { 
        sort: request.query.sort, 
        sortBy: request.query.sortBy,
        sortOrder: request.query.sortOrder,
        limit, 
        offset, 
        page, 
        filters: parsedFilters 
      };
      const items = await this.entityService.list(request.params.entityName, params);

      // If repository returned pagination metadata, wrap with paginationResponse
      if (items && Object.prototype.hasOwnProperty.call(items, 'data') && typeof items.total === 'number') {
        const resp = paginationResponse({ data: items.data, total: items.total, page, limit, offset });
        return sendSuccess(reply, resp, 'Entities loaded');
      }

      return sendSuccess(reply, items, 'Entities loaded');
    } catch (error) {
      return sendError(reply, error, error.statusCode || 500);
    }
  }

  async get(request, reply) {
    try {
      const entity = await this.entityService.get(request.params.entityName, request.params.id);
      return sendSuccess(reply, entity, 'Entity fetched');
    } catch (error) {
      return sendError(reply, error, error.statusCode || 404);
    }
  }

  async create(request, reply) {
    try {
      const entity = await this.entityService.create(
        request.params.entityName,
        request.body,
        {
          user: request.user,
          ipAddress: request.ip,
          headers: request.headers,
        }
      );
      return sendCreated(reply, entity, 'Entity created');
    } catch (error) {
      return sendError(reply, error, error.statusCode || 500);
    }
  }

  async update(request, reply) {
    try {
      const entity = await this.entityService.update(
        request.params.entityName,
        request.params.id,
        request.body,
        {
          user: request.user,
          ipAddress: request.ip,
          headers: request.headers,
        }
      );
      return sendSuccess(reply, entity, 'Entity updated');
    } catch (error) {
      return sendError(reply, error, error.statusCode || 404);
    }
  }

  async delete(request, reply) {
    try {
      const entity = await this.entityService.delete(request.params.entityName, request.params.id);
      return sendSuccess(reply, entity, 'Entity removed');
    } catch (error) {
      return sendError(reply, error, error.statusCode || 404);
    }
  }

  async validateMasterContracts(request, reply) {
    try {
      const rows = Array.isArray(request.body?.rows) ? request.body.rows : [];
      if (rows.length === 0) {
        return sendError(reply, new Error('No data rows were submitted for validation.'), 400);
      }
      const result = this.entityService.validateMasterContractRawRows(rows);
      if (!result.valid) {
        const summary = result.errors
          .slice(0, 20)
          .map((e) => `Row ${e.row} – "${e.field}": value "${e.value}" is not a valid ${e.expected}`)
          .join('\n');
        const more = result.errors.length > 20 ? `\n... and ${result.errors.length - 20} more error(s).` : '';
        const error = new Error(`Validation failed. ${result.errors.length} error(s) found:\n${summary}${more}`);
        error.statusCode = 422;
        return sendError(reply, error, 422);
      }
      return sendSuccess(reply, { valid: true, rowCount: rows.length }, 'Validation successful.');
    } catch (error) {
      return sendError(reply, error, error.statusCode || 500);
    }
  }

  async validateDebtors(request, reply) {
    try {
      const rows = Array.isArray(request.body?.rows) ? request.body.rows : [];
      if (rows.length === 0) {
        return sendError(reply, new Error('No data rows were submitted for validation.'), 400);
      }
      const result = this.entityService.validateDebtorRawRows(rows);
      if (!result.valid) {
        const summary = result.errors
          .slice(0, 20)
          .map((e) => `Row ${e.row} – "${e.field}": value "${e.value}" is not a valid ${e.expected}`)
          .join('\n');
        const more = result.errors.length > 20 ? `\n... and ${result.errors.length - 20} more error(s).` : '';
        const error = new Error(`Validation failed. ${result.errors.length} error(s) found:\n${summary}${more}`);
        error.statusCode = 422;
        return sendError(reply, error, 422);
      }
      return sendSuccess(reply, { valid: true, rowCount: rows.length }, 'Validation successful.');
    } catch (error) {
      return sendError(reply, error, error.statusCode || 500);
    }
  }

  async validateClaims(request, reply) {
    try {
      const rows = Array.isArray(request.body?.rows) ? request.body.rows : [];
      if (rows.length === 0) {
        return sendError(reply, new Error('No data rows were submitted for validation.'), 400);
      }
      const result = await this.entityService.validateClaimRows(rows);
      if (!result.valid) {
        const summary = result.errors
          .slice(0, 20)
          .map((e) => `Row ${e.row} – "${e.field}": value "${e.value}" is not a valid ${e.expected}`)
          .join('\n');
        const more = result.errors.length > 20 ? `\n... and ${result.errors.length - 20} more error(s).` : '';
        const error = new Error(`Validation failed. ${result.errors.length} error(s) found:\n${summary}${more}`);
        error.statusCode = 422;
        return sendError(reply, error, 422);
      }
      return sendSuccess(reply, { valid: true, rowCount: rows.length }, 'Validation successful.');
    } catch (error) {
      return sendError(reply, error, error.statusCode || 500);
    }
  }

  async validateSubrogation(request, reply) {
    try {
      const result = this.entityService.validateSubrogationPayload(request.body || {});
      if (!result.valid) {
        const summary = result.errors
          .map((e) => `"${e.field}": value "${e.value}" is not a valid ${e.expected}`)
          .join('\n');
        const error = new Error(`Subrogation validation failed:\n${summary}`);
        error.statusCode = 422;
        return sendError(reply, error, 422);
      }
      return sendSuccess(reply, { valid: true }, 'Validation successful.');
    } catch (error) {
      return sendError(reply, error, error.statusCode || 500);
    }
  }

  async uploadMasterContracts(request, reply) {
    try {
      const isReviseMode = String(request.body?.uploadMode || '').toLowerCase() === 'revise';
      const result = await this.entityService.uploadMasterContractsAtomic(
        request.body,
        {
          user: request.user,
          ipAddress: request.ip,
          headers: request.headers,
        }
      );

      // Fire-and-forget upload email
      const uploaderEmail = request.user?.email;
      const firstContractId = result.contracts?.[0]?.contract_id;
      if (firstContractId && uploaderEmail) {
        WorkflowEmailService.sendUploadEmail({
          uploaderEmail,
          batchId: firstContractId,
          module: 'MC',
          count: result.createdCount,
        });
      }

      return sendCreated(
        reply,
        result,
        isReviseMode
          ? 'Revisi master contract berhasil diproses'
          : 'Master contracts uploaded successfully'
      );
    } catch (error) {
      return sendError(reply, error, error.statusCode || 500);
    }
  }

  async uploadDebtors(request, reply) {
    try {
      const isReviseMode = String(request.body?.uploadMode || '').toLowerCase() === 'revise';
      const result = await this.entityService.uploadDebtorsAtomic(
        request.body,
        {
          user: request.user,
          ipAddress: request.ip,
          headers: request.headers,
        }
      );

      // Fire-and-forget upload email
      const uploaderEmail = request.user?.email;
      const batchId = result.debtors?.[0]?.batch_id;
      if (batchId && uploaderEmail) {
        WorkflowEmailService.sendUploadEmail({
          uploaderEmail,
          batchId,
          module: 'DEBTOR',
          count: result.createdCount,
        });
      }

      return sendCreated(
        reply,
        result,
        isReviseMode
          ? 'Revisi debtor berhasil diproses'
          : 'Debtors uploaded successfully'
      );
    } catch (error) {
      return sendError(reply, error, error.statusCode || 500);
    }
  }

  async checkUploadDuplicates(request, reply) {
    try {
      const debtors = Array.isArray(request.body?.debtors)
        ? request.body.debtors
        : [];

      if (debtors.length === 0) {
        return sendError(
          reply,
          new Error('No debtors provided for duplicate check'),
          400
        );
      }

      const result = await this.entityService.checkUploadDuplicates(debtors);
      return sendSuccess(reply, result, 'Duplicate check completed');
    } catch (error) {
      return sendError(reply, error, error.statusCode || 500);
    }
  }

  async processMasterContractApproval(request, reply) {
    try {
      const result = await this.entityService.processMasterContractApprovalAtomic(
        request.params.contractId,
        request.body,
        {
          user: request.user,
          ipAddress: request.ip,
          headers: request.headers,
        }
      );
      return sendSuccess(reply, result, 'Master contract approval processed successfully');
    } catch (error) {
      return sendError(reply, error, error.statusCode || 500);
    }
  }

  /**
   * Start bulk debtor action (async)
   * Returns jobId immediately, background job processes debtors
   */
  async startBulkDebtorAction(request, reply) {
    try {
      const { action, filters, remarks, batchId, batch_id, contract_id } = request.body;

      if (!action || !['check', 'approve', 'revision'].includes(action)) {
        return sendError(reply, new Error('Invalid action'), 400);
      }

      // Build query filters from request filters object
      let queryFilters = {};
      if (filters?.contract_id) {
        queryFilters.contract_id = filters.contract_id;
      }
      if (filters?.batch_id) {
        queryFilters.batch_id = filters.batch_id;
      } else if (batch_id || batchId) {
        // If explicit batchId provided in request
        queryFilters.batch_id = batch_id || batchId;
      }
      if (filters?.submitStatus && filters.submitStatus !== 'all') {
        queryFilters.status = filters.submitStatus;
      }
      if (filters?.startDate || filters?.endDate) {
        queryFilters.created_at = {};
        if (filters.startDate) {
          queryFilters.created_at.gte = new Date(filters.startDate);
        }
        if (filters.endDate) {
          queryFilters.created_at.lte = new Date(filters.endDate);
        }
      }

      // Count matching debtors
      const totalCount = await prisma.debtor.count({
        where: queryFilters,
      });

      if (totalCount === 0) {
        return sendError(reply, new Error('No debtors match the specified filters'), 400);
      }

      // Create job
      const jobId = jobQueue.createJob({
        totalCount,
        message: `Starting ${action} action on ${totalCount} debtor(s)`,
        action,
        batchId: batch_id || batchId,
      });

      // Start job processing in background (don't await)
      processBulkDebtorActionBackground(jobId, action, queryFilters, remarks, request.user, batch_id || batchId, contract_id)
        .catch((err) => {
          console.error(`Background job ${jobId} failed:`, err);
          jobQueue.updateJob(jobId, {
            status: 'FAILED',
            message: `Job failed: ${err.message}`,
          });
        });

      return sendCreated(reply, { jobId, totalCount, message: `Job ${jobId} started` }, 'Bulk action job started');
    } catch (error) {
      return sendError(reply, error, error.statusCode || 500);
    }
  }

  /**
   * Get status of bulk debtor action job
   */
  async getDebtorJobStatus(request, reply) {
    try {
      const { jobId } = request.params;

      const job = jobQueue.getJobStatus(jobId);
      if (!job) {
        return sendError(reply, new Error(`Job ${jobId} not found`), 404);
      }

      return sendSuccess(reply, job, 'Job status retrieved');
    } catch (error) {
      return sendError(reply, error, error.statusCode || 500);
    }
  }

  /**
   * MC workflow-action: handles CHECK_BRINS, APPROVE_BRINS, CHECK_TUGURE, APPROVE, REVISION
   * POST /api/apps/:appId/master-contracts/:contractId/workflow-action
   * Body: { action: string, remarks?: string }
   */
  async processMasterContractWorkflowAction(request, reply) {
    try {
      const result = await this.entityService.processMasterContractWorkflowActionAtomic(
        request.params.contractId,
        request.body,
        {
          user: request.user,
          ipAddress: request.ip,
          headers: request.headers,
        }
      );
      return sendSuccess(reply, result, 'Master contract workflow action processed successfully');
    } catch (error) {
      return sendError(reply, error, error.statusCode || 500);
    }
  }

  /**
   * Claim workflow-action: handles CHECK_BRINS, APPROVE_BRINS, CHECK_TUGURE, APPROVE, REVISION
   * POST /api/apps/:appId/claims/:claimNo/workflow-action
   * Body: { action: string, remarks?: string }
   */
  async processClaimWorkflowAction(request, reply) {
    try {
      const { claimNo } = request.params;
      const { action, remarks } = request.body || {};
      const auditActor = {
        user_email: request.user?.email || 'system',
        user_role: request.user?.role || 'system',
      };

      const VALID_ACTIONS = ['CHECK_BRINS', 'APPROVE_BRINS', 'CHECK_TUGURE', 'APPROVE', 'REVISION'];
      if (!action || !VALID_ACTIONS.includes(action.toUpperCase())) {
        return sendError(reply, new Error(`Invalid action. Must be one of: ${VALID_ACTIONS.join(', ')}`), 400);
      }

      let result;
      const upperAction = action.toUpperCase();

      if (upperAction === 'CHECK_BRINS' || upperAction === 'CHECK_TUGURE') {
        result = await ClaimService.processClaimCheck(claimNo, auditActor);
      } else if (upperAction === 'APPROVE_BRINS' || upperAction === 'APPROVE') {
        result = await ClaimService.processClaimApproval(claimNo, remarks || '', auditActor);
      } else if (upperAction === 'REVISION') {
        result = await ClaimService.processClaimRevision(claimNo, remarks || '', auditActor);
      }

      if (!result.success) {
        const err = new Error(result.error || 'Claim workflow action failed');
        err.statusCode = 400;
        return sendError(reply, err, 400);
      }

      // Fire-and-forget emails
      const claim = await prisma.claim.findUnique({ where: { claim_no: claimNo } });
      if (claim) {
        const batch = claim.batch_id ? await prisma.batch.findUnique({ where: { batch_id: claim.batch_id } }) : null;
        const uploaderEmail = batch?.uploaded_by || claim.batch_uploaded_by;
        const ctx = {
          actorEmail: auditActor.user_email,
          uploaderEmail,
          checkerEmail: claim.checked_by,
          checkerBrinsEmail: claim.checked_by,
          approverBrinsEmail: claim.approved_by_brins,
          checkerTugureEmail: claim.checked_by_tugure,
          batchId: claimNo,
          module: 'CLAIM',
          remarks,
        };
        if (upperAction === 'CHECK_BRINS') WorkflowEmailService.sendCheckBrinsEmail(ctx);
        else if (upperAction === 'APPROVE_BRINS') WorkflowEmailService.sendApproveBrinsEmail(ctx);
        else if (upperAction === 'CHECK_TUGURE') WorkflowEmailService.sendCheckTugureEmail(ctx);
        else if (upperAction === 'APPROVE') WorkflowEmailService.sendApproveFinalEmail(ctx);
        else if (upperAction === 'REVISION') WorkflowEmailService.sendRevisionEmail({ uploaderEmail, batchId: claimNo, module: 'CLAIM', remarks });
      }

      return sendSuccess(reply, result, 'Claim workflow action processed successfully');
    } catch (error) {
      return sendError(reply, error, error.statusCode || 500);
    }
  }

  // ── Debtor aggregates ────────────────────────────────────────────────────

  async getDebtorStatusCounts(request, reply) {
    try {
      const counts = await DebtorService.getStatusCounts();
      return sendSuccess(reply, counts, 'Status counts fetched');
    } catch (error) {
      return sendError(reply, error, 500);
    }
  }

  async getDebtorBatchSummary(request, reply) {
    try {
      const { batchId } = request.params;
      const summary = await DebtorService.getBatchSummary(batchId);
      return sendSuccess(reply, summary, 'Batch summary fetched');
    } catch (error) {
      return sendError(reply, error, 500);
    }
  }

  async batchDebtorWorkflowAction(request, reply) {
    try {
      const { debtorIds, action, remarks } = request.body || {};
      if (!Array.isArray(debtorIds) || debtorIds.length === 0) {
        return sendError(reply, new Error('debtorIds must be a non-empty array'), 400);
      }
      const VALID = ['check', 'approve', 'revise'];
      if (!VALID.includes(action)) {
        return sendError(reply, new Error(`action must be one of: ${VALID.join(', ')}`), 400);
      }
      const auditActor = {
        user_email: request.user?.email || 'system',
        user_role: request.user?.role || 'system',
      };
      const result = await DebtorService.processBatchDebtorWorkflowAction(debtorIds, action, remarks || '', auditActor);
      return sendSuccess(reply, result, `Batch ${action} completed`);
    } catch (error) {
      return sendError(reply, error, 500);
    }
  }

  // ── Master Contract extras ────────────────────────────────────────────────

  async closeMasterContract(request, reply) {
    try {
      const { contractId } = request.params;
      const { actionType, remarks } = request.body || {};
      if (!['close', 'invalidate'].includes(actionType)) {
        return sendError(reply, new Error('actionType must be "close" or "invalidate"'), 400);
      }
      const newStatus = actionType === 'close' ? 'Inactive' : 'Archived';
      const mc = await prisma.masterContract.findUnique({ where: { contract_id: contractId } });
      if (!mc) return sendError(reply, new Error(`MasterContract ${contractId} not found`), 404);
      await prisma.masterContract.update({
        where: { contract_id: contractId },
        data: { effective_status: newStatus, remark: remarks || '' },
      });
      const auditActor = this.entityService.resolveAuditActor({ user: request.user });
      try {
        await prisma.auditLog.create({
          data: {
            action: `CONTRACT_${actionType.toUpperCase()}`,
            module: 'CONFIG',
            entity_type: 'MasterContract',
            entity_id: contractId,
            old_value: JSON.stringify({ status: mc.effective_status }),
            new_value: JSON.stringify({ status: newStatus }),
            user_email: auditActor.user_email,
            user_role: auditActor.user_role,
            reason: remarks || '',
          },
        });
      } catch (auditErr) {
        console.warn('Audit failed:', auditErr);
      }
      return sendSuccess(reply, { contractId, newStatus }, `Contract ${actionType}d`);
    } catch (error) {
      return sendError(reply, error, 500);
    }
  }

  // ── Claim extras ──────────────────────────────────────────────────────────

  async getNextClaimSequence(request, reply) {
    try {
      const prefix = request.query?.prefix || '';
      const seq = await ClaimService.getNextClaimSequence(prefix);
      return sendSuccess(reply, { sequence: seq }, 'Sequence fetched');
    } catch (error) {
      return sendError(reply, error, 500);
    }
  }

  async createSubrogation(request, reply) {
    try {
      const auditActor = this.entityService.resolveAuditActor({ user: request.user });
      const subId = await ClaimService.createSubrogationEntry(request.body || {}, auditActor);
      return sendCreated(reply, { subrogation_id: subId }, 'Subrogation created');
    } catch (error) {
      return sendError(reply, error, 500);
    }
  }

  async processSubrogationWorkflowAction(request, reply) {
    try {
      const { subId } = request.params;
      const { action, ...data } = request.body || {};
      const VALID = ['check_brins', 'approve_brins', 'check_tugure', 'approve', 'revise'];
      if (!VALID.includes(action)) {
        return sendError(reply, new Error(`action must be one of: ${VALID.join(', ')}`), 400);
      }
      const auditActor = this.entityService.resolveAuditActor({ user: request.user });
      const notaNumber = await ClaimService.processSubrogationWorkflow(subId, action, data, auditActor);

      // Fire-and-forget emails
      const sub = await prisma.subrogation.findUnique({ where: { subrogation_id: subId } });
      if (sub) {
        const ctx = {
          actorEmail: auditActor.user_email,
          uploaderEmail: sub.checked_by || auditActor.user_email,
          checkerEmail: sub.checked_by,
          checkerBrinsEmail: sub.checked_by,
          approverBrinsEmail: sub.approved_by_brins,
          checkerTugureEmail: sub.checked_by_tugure,
          batchId: subId,
          module: 'SUBROGATION',
          remarks: data.remarks,
        };
        if (action === 'check_brins') WorkflowEmailService.sendCheckBrinsEmail(ctx);
        else if (action === 'approve_brins') WorkflowEmailService.sendApproveBrinsEmail(ctx);
        else if (action === 'check_tugure') WorkflowEmailService.sendCheckTugureEmail(ctx);
        else if (action === 'approve') WorkflowEmailService.sendApproveFinalEmail(ctx);
        else if (action === 'revise') WorkflowEmailService.sendRevisionEmail({ uploaderEmail: sub.checked_by || auditActor.user_email, batchId: subId, module: 'SUBROGATION', remarks: data.remarks });
      }

      return sendSuccess(reply, { subrogation_id: subId, notaNumber: notaNumber || null }, `Subrogation ${action} complete`);
    } catch (error) {
      return sendError(reply, error, 500);
    }
  }

  async getClaimReviewContext(request, reply) {
    try {
      const context = await ClaimService.getClaimReviewContext();
      return sendSuccess(reply, context, 'Context loaded');
    } catch (error) {
      return sendError(reply, error, 500);
    }
  }

  // ── Nota extras ───────────────────────────────────────────────────────────

  async getNotaContext(request, reply) {
    try {
      const context = await NotaService.getNotaContext();
      return sendSuccess(reply, context, 'Context loaded');
    } catch (error) {
      return sendError(reply, error, 500);
    }
  }

  async recordNotaPayment(request, reply) {
    try {
      const { notaId } = request.params;
      const userEmail = request.user?.email || 'system';
      const paymentRef = await NotaService.recordNotaPayment(notaId, { ...request.body, userEmail });
      return sendSuccess(reply, { payment_ref: paymentRef }, 'Payment recorded');
    } catch (error) {
      return sendError(reply, error, 500);
    }
  }

  async bulkMarkNotasPaid(request, reply) {
    try {
      const { notaNumbers } = request.body || {};
      if (!Array.isArray(notaNumbers) || notaNumbers.length === 0) {
        return sendError(reply, new Error('notaNumbers must be a non-empty array'), 400);
      }
      const userEmail = request.user?.email || 'system';
      const updated = await NotaService.bulkMarkNotasPaid(notaNumbers, userEmail);
      return sendSuccess(reply, { updated }, `${updated.length} notas marked as PAID`);
    } catch (error) {
      return sendError(reply, error, 500);
    }
  }
}

/**
 * Background job processor for bulk debtor actions
 * Processes debtors asynchronously and updates job status
 */
async function processBulkDebtorActionBackground(jobId, action, queryFilters, remarks, user, batchId, contractId) {
  try {
    jobQueue.updateJob(jobId, { status: 'PROCESSING' });

    // Fetch all matching debtors
    const debtors = await prisma.debtor.findMany({
      where: queryFilters,
    });

    let processedCount = 0;
    let failedCount = 0;
    const errors = [];
    let totalNetPremi = 0;

    const auditActor = {
      user_email: user?.email || 'system',
      user_role: user?.role || 'system',
    };

    // Process each debtor
    for (const debtor of debtors) {
      jobQueue.updateJob(jobId, {
        currentDebtorId: debtor.id,
        processedCount: processedCount + failedCount,
        message: `Processing ${debtor.nama_peserta}...`,
      });

      let result;
      if (action === 'check') {
        result = await DebtorService.processDebtorCheck(debtor.id, auditActor, { emitNotification: false });
      } else if (action === 'approve') {
        result = await DebtorService.processDebtorApproval(debtor.id, remarks, auditActor, debtor.contract_id, { emitNotification: false });
        if (result.success) {
          totalNetPremi += parseFloat(debtor.net_premi) || 0;
        }
      } else if (action === 'revision') {
        result = await DebtorService.processDebtorRevision(debtor.id, remarks, auditActor, { emitNotification: false });
      }

      if (result.success) {
        processedCount++;
      } else {
        failedCount++;
        errors.push({
          debtorId: debtor.id,
          nama: debtor.nama_peserta,
          error: result.error,
        });
      }
    }

    // Fallback: if contractId wasn't provided, try to fetch it from the Batch table
    let actualContractId = contractId;
    let batchRecord = null;
    if (batchId) {
      try {
        batchRecord = await prisma.batch.findUnique({
          where: { batch_id: batchId },
        });
        if (!actualContractId && batchRecord && batchRecord.contract_id) {
          actualContractId = batchRecord.contract_id;
        }
      } catch (err) {
        console.warn(`Failed to fetch batch ${batchId}:`, err);
      }
    }

    // Create Nota if action is approve and debtors were successfully processed
    if (action === 'approve' && processedCount > 0 && batchId && actualContractId) {
      try {
        const notaNumber = `NOTA-${actualContractId}-${Date.now()}`;
        // Check if nota already exists for this batch
        const existingNota = await prisma.nota.findFirst({
          where: { reference_id: batchId },
        });

        if (!existingNota) {
          // Read aggregate values from the Batch (populated during debtor upload)
          const notaPremium = parseFloat(batchRecord?.premium) || 0;
          const notaCommission = parseFloat(batchRecord?.commission) || 0;
          const notaClaim = parseFloat(batchRecord?.claim) || 0;
          const notaTotal = parseFloat(batchRecord?.total) || 0;
          const notaNetDue = parseFloat(batchRecord?.net_due) || 0;

          await prisma.nota.create({
            data: {
              nota_number: notaNumber,
              nota_type: 'Batch',
              reference_id: batchId,
              contract_id: actualContractId,
              amount: totalNetPremi,
              currency: 'IDR',
              status: 'UNPAID',
              issued_by: auditActor.user_email || 'system',
              issued_date: new Date(),
              total_actual_paid: 0,
              reconciliation_status: 'PENDING',
              premium: notaPremium,
              commission: notaCommission,
              claim: notaClaim,
              total: notaTotal,
              net_due: notaNetDue,
            },
          });
          console.log(`Nota created: ${notaNumber} for batch ${batchId}`);
        } else {
          console.log(`Nota already exists for batch ${batchId}, skipping creation`);
        }
      } catch (notaError) {
        console.warn(`Failed to create Nota for batch ${batchId}:`, notaError);
      }
    }

    // Create batch-level notification (one per role) when job finishes and batchId is provided
    if (processedCount > 0 && batchId) {
      try {
        const notifRepo = new NotificationRepository();
        const notifTitle = `Bulk ${action} completed for batch ${batchId}`;
        const notifMessage = `Bulk ${action} completed: ${processedCount} succeeded, ${failedCount} failed.`;
        for (const role of ALL_ROLES) {
          await notifRepo.create({
            title: notifTitle,
            message: notifMessage,
            type: 'INFO',
            module: 'DEBTOR',
            reference_id: batchId,
            target_role: role,
          });
        }
      } catch (notifErr) {
        console.warn(`Failed to create batch notification for job ${jobId}:`, notifErr);
      }
    }

    // Send batch-level workflow email using WorkflowEmailService (fire-and-forget)
    if (processedCount > 0 && batchId) {
      const actorEmail = auditActor.user_email || 'system';
      const ctx = {
        actorEmail,
        uploaderEmail: batchRecord?.uploaded_by,
        checkerBrinsEmail: batchRecord?.validated_by,
        approverBrinsEmail: batchRecord?.approved_by,
        checkerTugureEmail: batchRecord?.tugure_checked_by,
        batchId,
        module: 'DEBTOR',
        remarks,
      };

      if (action === 'check') {
        // Determine if this is BRINS check or TUGURE check from the first debtor's status
        const sampleDebtor = debtors[0];
        if (sampleDebtor?.status === 'SUBMITTED') {
          WorkflowEmailService.sendCheckBrinsEmail({ ...ctx, uploaderEmail: batchRecord?.uploaded_by });
        } else {
          WorkflowEmailService.sendCheckTugureEmail(ctx);
        }
      } else if (action === 'approve') {
        const sampleDebtor = debtors[0];
        if (sampleDebtor?.status === 'CHECKED_BRINS') {
          WorkflowEmailService.sendApproveBrinsEmail({ ...ctx, checkerEmail: batchRecord?.validated_by });
        } else {
          WorkflowEmailService.sendApproveFinalEmail(ctx);
        }
      } else if (action === 'revision') {
        WorkflowEmailService.sendRevisionEmail({ uploaderEmail: batchRecord?.uploaded_by, batchId, module: 'DEBTOR', remarks });
      }
    }

    // Mark job as completed
    jobQueue.completeJob(jobId, {
      status: 'COMPLETED',
      processedCount,
      failedCount,
      message: `Completed: ${processedCount} success, ${failedCount} failed`,
      errors,
    });

    console.log(`Job ${jobId} completed: ${processedCount} processed, ${failedCount} failed`);
  } catch (error) {
    console.error(`Background job ${jobId} error:`, error);
    jobQueue.completeJob(jobId, {
      status: 'FAILED',
      message: `Job failed: ${error.message}`,
      errors: [{ error: error.message }],
    });
  }
}
