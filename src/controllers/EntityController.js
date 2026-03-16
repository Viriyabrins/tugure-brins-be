import { sendSuccess, sendCreated, sendError } from '../utils/response.js';
import { paginate, paginationResponse } from '../utils/pagination.js';
import * as jobQueue from '../utils/jobQueue.js';
import * as DebtorService from '../services/DebtorService.js';
import prisma from '../prisma/client.js';

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

      const params = { sort: request.query.sort, limit, offset, page, filters: parsedFilters };
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
        result = await DebtorService.processDebtorCheck(debtor.id, auditActor);
      } else if (action === 'approve') {
        result = await DebtorService.processDebtorApproval(debtor.id, remarks, auditActor, debtor.contract_id);
        if (result.success) {
          totalNetPremi += parseFloat(debtor.net_premi) || 0;
        }
      } else if (action === 'revision') {
        result = await DebtorService.processDebtorRevision(debtor.id, remarks, auditActor);
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

    // Create Nota if action is approve and debtors were successfully processed
    if (action === 'approve' && processedCount > 0 && batchId && contractId) {
      try {
        const notaNumber = `NOTA-${contractId}-${Date.now()}`;
        // Check if nota already exists for this batch
        const existingNota = await prisma.nota.findFirst({
          where: { reference_id: batchId },
        });

        if (!existingNota) {
          await prisma.nota.create({
            data: {
              nota_number: notaNumber,
              nota_type: 'Batch',
              reference_id: batchId,
              contract_id: contractId,
              amount: totalNetPremi,
              currency: 'IDR',
              status: 'UNPAID',
              issued_by: auditActor.user_email || 'system',
              issued_date: new Date(),
              total_actual_paid: 0,
              reconciliation_status: 'PENDING',
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
