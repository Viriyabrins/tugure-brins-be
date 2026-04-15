import EntityController from '../controllers/EntityController.js';
import EntityService from '../services/EntityService.js';
import { EntityRepository } from '../repositories/EntityRepository.js';

export default async function (fastify) {
  const repository = new EntityRepository(fastify.db);
  const service = new EntityService({ entityRepository: repository });
  const controller = new EntityController({ entityService: service });

  fastify.get(
    '/apps/:appId/entities/:entityName',
    { preHandler: fastify.authenticate },
    controller.list.bind(controller)
  );

  fastify.get(
    '/apps/:appId/entities/:entityName/:id',
    { preHandler: fastify.authenticate },
    controller.get.bind(controller)
  );

  fastify.post(
    '/apps/:appId/entities/:entityName',
    { preHandler: fastify.authenticate },
    controller.create.bind(controller)
  );

  fastify.post(
    '/apps/:appId/master-contracts/validate',
    { preHandler: fastify.authenticate },
    controller.validateMasterContracts.bind(controller)
  );

  fastify.post(
    '/apps/:appId/debtors/validate',
    { preHandler: fastify.authenticate },
    controller.validateDebtors.bind(controller)
  );

  fastify.post(
    '/apps/:appId/claims/validate',
    { preHandler: fastify.authenticate },
    controller.validateClaims.bind(controller)
  );

  fastify.post(
    '/apps/:appId/subrogations/validate',
    { preHandler: fastify.authenticate },
    controller.validateSubrogation.bind(controller)
  );

  fastify.post(
    '/apps/:appId/master-contracts/upload',
    { preHandler: fastify.authenticate },
    controller.uploadMasterContracts.bind(controller)
  );

  fastify.post(
    '/apps/:appId/debtors/upload',
    { preHandler: fastify.authenticate },
    controller.uploadDebtors.bind(controller)
  );

  fastify.post(
    '/apps/:appId/debtors/check-duplicates',
    { preHandler: fastify.authenticate },
    controller.checkUploadDuplicates.bind(controller)
  );

  fastify.post(
    '/apps/:appId/master-contracts/:contractId/approval',
    { preHandler: fastify.authenticate },
    controller.processMasterContractApproval.bind(controller)
  );

  fastify.post(
    '/apps/:appId/analytics/track/batch',
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      console.log('Analytics data received:', request.body);

      return reply.send({
        success: true,
        message: 'Analytics tracked'
      });
    }
  );

  fastify.put(
    '/apps/:appId/entities/:entityName/:id',
    { preHandler: fastify.authenticate },
    controller.update.bind(controller)
  );

  fastify.delete(
    '/apps/:appId/entities/:entityName/:id',
    { preHandler: fastify.authenticate },
    controller.delete.bind(controller)
  );

  /**
   * Bulk debtor action endpoints
   */
  fastify.post(
    '/apps/:appId/bulk-debtor-action',
    { preHandler: fastify.authenticate },
    controller.startBulkDebtorAction.bind(controller)
  );

  fastify.get(
    '/apps/:appId/debtor-jobs/:jobId',
    { preHandler: fastify.authenticate },
    controller.getDebtorJobStatus.bind(controller)
  );

  /**
   * Master Contract workflow-action endpoint
   * Handles: CHECK_BRINS, APPROVE_BRINS, CHECK_TUGURE, APPROVE, REVISION
   * POST /api/apps/:appId/master-contracts/:contractId/workflow-action
   * Body: { action: string, remarks?: string }
   */
  fastify.post(
    '/apps/:appId/master-contracts/:contractId/workflow-action',
    { preHandler: fastify.authenticate },
    controller.processMasterContractWorkflowAction.bind(controller)
  );

  /**
   * Claim workflow-action endpoint
   * Handles: CHECK_BRINS, APPROVE_BRINS, CHECK_TUGURE, APPROVE, REVISION
   * POST /api/apps/:appId/claims/:claimNo/workflow-action
   * Body: { action: string, remarks?: string }
   */
  fastify.post(
    '/apps/:appId/claims/:claimNo/workflow-action',
    { preHandler: fastify.authenticate },
    controller.processClaimWorkflowAction.bind(controller)
  );

  // ── Debtor aggregates ──────────────────────────────────────────────────────
  fastify.get(
    '/apps/:appId/debtors/status-counts',
    { preHandler: fastify.authenticate },
    controller.getDebtorStatusCounts.bind(controller)
  );

  fastify.get(
    '/apps/:appId/debtors/batch-summary/:batchId',
    { preHandler: fastify.authenticate },
    controller.getDebtorBatchSummary.bind(controller)
  );

  fastify.post(
    '/apps/:appId/debtors/batch-workflow-action',
    { preHandler: fastify.authenticate },
    controller.batchDebtorWorkflowAction.bind(controller)
  );

  // ── Master Contract extras ─────────────────────────────────────────────────
  fastify.post(
    '/apps/:appId/master-contracts/:contractId/close-or-invalidate',
    { preHandler: fastify.authenticate },
    controller.closeMasterContract.bind(controller)
  );

  // ── Claim extras ───────────────────────────────────────────────────────────
  fastify.get(
    '/apps/:appId/claims/next-sequence',
    { preHandler: fastify.authenticate },
    controller.getNextClaimSequence.bind(controller)
  );

  fastify.post(
    '/apps/:appId/subrogations',
    { preHandler: fastify.authenticate },
    controller.createSubrogation.bind(controller)
  );

  fastify.post(
    '/apps/:appId/subrogations/:subId/workflow-action',
    { preHandler: fastify.authenticate },
    controller.processSubrogationWorkflowAction.bind(controller)
  );

  fastify.get(
    '/apps/:appId/claim-review/context',
    { preHandler: fastify.authenticate },
    controller.getClaimReviewContext.bind(controller)
  );

  // ── Nota extras ────────────────────────────────────────────────────────────
  fastify.get(
    '/apps/:appId/nota/context',
    { preHandler: fastify.authenticate },
    controller.getNotaContext.bind(controller)
  );

  fastify.post(
    '/apps/:appId/notas/:notaId/record-payment',
    { preHandler: fastify.authenticate },
    controller.recordNotaPayment.bind(controller)
  );
}

