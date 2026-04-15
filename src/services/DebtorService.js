import prisma from '../prisma/client.js';

/**
 * DebtorService: Encapsulates business logic for debtor actions
 * Used by both individual and bulk operations
 */

const ALL_ROLES = ['maker-brins-role', 'checker-brins-role', 'approver-brins-role', 'checker-tugure-role', 'approver-tugure-role'];

/**
 * Process single debtor CHECK action
 * BRINS workflow: SUBMITTED → CHECKED_BRINS
 * Tugure workflow: APPROVED_BRINS → CHECKED_TUGURE
 * @param {string} debtorId
 * @param {Object} auditActor - { user_email, user_role }
 * @returns {Object} result with success status and count
 */
export async function processDebtorCheck(debtorId, auditActor = {}, options = {}) {
  try {
    // Fetch current debtor
    const debtor = await prisma.debtor.findUnique({
      where: { id: debtorId },
    });

    if (!debtor) {
      throw new Error(`Debtor ${debtorId} not found`);
    }

    // Determine workflow context based on current status
    let newStatus, actionLabel, actionType;
    
    if (debtor.status === 'SUBMITTED') {
      // BRINS workflow: SUBMITTED → CHECKED_BRINS
      newStatus = 'CHECKED_BRINS';
      actionLabel = 'DEBTOR_CHECKED_BRINS';
      actionType = 'BRINS Checker';
    } else if (debtor.status === 'APPROVED_BRINS') {
      // Tugure workflow: APPROVED_BRINS → CHECKED_TUGURE
      newStatus = 'CHECKED_TUGURE';
      actionLabel = 'DEBTOR_CHECKED_TUGURE';
      actionType = 'Tugure Checker';
    } else {
      throw new Error(`Debtor ${debtorId} has invalid status: ${debtor.status}, expected SUBMITTED or APPROVED_BRINS`);
    }

    // Update debtor status
    await prisma.debtor.update({
      where: { id: debtorId },
      data: { status: newStatus },
    });

    // Record actor on the parent Batch for later email context
    try {
      if (newStatus === 'CHECKED_BRINS') {
        await prisma.batch.update({
          where: { batch_id: debtor.batch_id },
          data: { validated_by: auditActor.user_email || 'system', validated_date: new Date() },
        });
      } else if (newStatus === 'CHECKED_TUGURE') {
        await prisma.batch.update({
          where: { batch_id: debtor.batch_id },
          data: { tugure_checked_by: auditActor.user_email || 'system', tugure_checked_date: new Date() },
        });
      }
    } catch (batchErr) {
      console.warn(`Failed to update batch actor field for ${debtor.batch_id}:`, batchErr);
    }

    // Create audit log
    try {
      await prisma.auditLog.create({
        data: {
          action: actionLabel,
          module: 'DEBTOR',
          entity_type: 'Debtor',
          entity_id: debtorId,
          old_value: JSON.stringify({ status: debtor.status }),
          new_value: JSON.stringify({ status: newStatus, remarks: '' }),
          user_email: auditActor.user_email || 'system',
          user_role: auditActor.user_role || 'system',
          reason: `${actionType} checked debtor ${debtor.nama_peserta}`,
        },
      });
    } catch (auditError) {
      console.warn(`Failed to create audit log for debtor ${debtorId}:`, auditError);
    }

    const { emitNotification = true } = options;

    // Create notifications for all roles (skip when caller disables emitNotification)
    if (emitNotification) {
      try {
        for (const role of ALL_ROLES) {
          await prisma.notification.create({
            data: {
              title: newStatus === 'CHECKED_BRINS' ? 'Debtor Checked by BRINS' : 'Debtor Checked by Tugure',
              message: `${actionType} (${auditActor.user_email || 'system'}) checked debtor ${debtor.nama_peserta}.`,
              type: 'INFO',
              module: 'DEBTOR',
              reference_id: debtor.batch_id,
              target_role: role,
            },
          });
        }
      } catch (notifError) {
        console.warn(`Failed to create notifications for debtor ${debtorId}:`, notifError);
      }
    }

    return { success: true, debtorId, message: 'Debtor checked successfully' };
  } catch (error) {
    console.error(`Error checking debtor ${debtorId}:`, error);
    return { success: false, debtorId, error: error.message };
  }
}

/**
 * Process single debtor APPROVAL action
 * BRINS workflow: CHECKED_BRINS → APPROVED_BRINS
 * Tugure workflow: CHECKED_TUGURE → APPROVED
 * @param {string} debtorId
 * @param {string} remarks
 * @param {Object} auditActor - { user_email, user_role }
 * @param {string} contractId - for Nota generation (Tugure only)
 * @returns {Object} result with success status
 */
export async function processDebtorApproval(debtorId, remarks = '', auditActor = {}, contractId = null, options = {}) {
  try {
    // Fetch current debtor
    const debtor = await prisma.debtor.findUnique({
      where: { id: debtorId },
    });

    if (!debtor) {
      throw new Error(`Debtor ${debtorId} not found`);
    }

    // Determine workflow context based on current status
    let newStatus, actionLabel, actionType, shouldCreateRecord = false;
    
    if (debtor.status === 'CHECKED_BRINS') {
      // BRINS workflow: CHECKED_BRINS → APPROVED_BRINS
      newStatus = 'APPROVED_BRINS';
      actionLabel = 'DEBTOR_APPROVED_BRINS';
      actionType = 'BRINS Approver';
      shouldCreateRecord = false;
    } else if (debtor.status === 'CHECKED_TUGURE') {
      // Tugure workflow: CHECKED_TUGURE → APPROVED
      newStatus = 'APPROVED';
      actionLabel = 'DEBTOR_APPROVED';
      actionType = 'Tugure Approver';
      shouldCreateRecord = true;
    } else {
      throw new Error(`Debtor ${debtorId} has invalid status: ${debtor.status}, expected CHECKED_BRINS or CHECKED_TUGURE`);
    }

    // Update debtor status
    await prisma.debtor.update({
      where: { id: debtorId },
      data: {
        status: newStatus,
      },
    });

    // Record actor on the parent Batch for later email context
    try {
      if (newStatus === 'APPROVED_BRINS') {
        await prisma.batch.update({
          where: { batch_id: debtor.batch_id },
          data: { approved_by: auditActor.user_email || 'system', approved_date: new Date() },
        });
      } else if (newStatus === 'APPROVED') {
        await prisma.batch.update({
          where: { batch_id: debtor.batch_id },
          data: { tugure_approved_by: auditActor.user_email || 'system', tugure_approved_date: new Date() },
        });
      }
    } catch (batchErr) {
      console.warn(`Failed to update batch actor field for ${debtor.batch_id}:`, batchErr);
    }

    // Create Record for approved debtor (only in Tugure workflow)
    if (shouldCreateRecord) {
      try {
        await prisma.record.create({
          data: {
            batch_id: debtor.batch_id,
            debtor_id: debtorId,
            record_status: 'Accepted',
            exposure_amount: parseFloat(debtor.plafon) || 0,
            premium_amount: parseFloat(debtor.net_premi) || 0,
            revision_count: 0,
            accepted_by: auditActor.user_email || 'system',
            accepted_date: new Date(),
          },
        });
      } catch (recordError) {
        console.warn(`Failed to create Record for debtor ${debtorId}:`, recordError);
      }
    }

    // Create audit log
    try {
      await prisma.auditLog.create({
        data: {
          action: actionLabel,
          module: 'DEBTOR',
          entity_type: 'Debtor',
          entity_id: debtorId,
          old_value: JSON.stringify({ status: debtor.status }),
          new_value: JSON.stringify({ status: newStatus, remarks }),
          user_email: auditActor.user_email || 'system',
          user_role: auditActor.user_role || 'system',
          reason: remarks || `Debtor approved by ${auditActor.user_email}`,
        },
      });
    } catch (auditError) {
      console.warn(`Failed to create audit log for debtor ${debtorId}:`, auditError);
    }

    const { emitNotification = true } = options;

    // Create notifications (skip when caller disables emitNotification)
    if (emitNotification) {
      try {
        for (const role of ALL_ROLES) {
          await prisma.notification.create({
            data: {
              title: newStatus === 'APPROVED_BRINS' ? 'Debtor Approved by BRINS' : 'Debtor Approved (Final)',
              message: `${actionType} (${auditActor.user_email || 'system'}) approved debtor ${debtor.nama_peserta}.`,
              type: 'INFO',
              module: 'DEBTOR',
              reference_id: debtorId,
              target_role: role,
            },
          });
        }
      } catch (notifError) {
        console.warn(`Failed to create notifications for debtor ${debtorId}:`, notifError);
      }
    }

    return { success: true, debtorId, message: 'Debtor approved successfully' };
  } catch (error) {
    console.error(`Error approving debtor ${debtorId}:`, error);
    return { success: false, debtorId, error: error.message };
  }
}

/**
 * Process single debtor REVISION action (CHECKED_TUGURE → REVISION)
 * @param {string} debtorId
 * @param {string} remarks - revision reason
 * @param {Object} auditActor - { user_email, user_role }
 * @returns {Object} result with success status
 */
export async function processDebtorRevision(debtorId, remarks = '', auditActor = {}, options = {}) {
  try {
    // Fetch current debtor
    const debtor = await prisma.debtor.findUnique({
      where: { id: debtorId },
    });

    if (!debtor) {
      throw new Error(`Debtor ${debtorId} not found`);
    }

    if (debtor.status !== 'CHECKED_TUGURE') {
      throw new Error(`Debtor ${debtorId} has invalid status: ${debtor.status}, expected CHECKED_TUGURE`);
    }

    // Update debtor status to REVISION
    await prisma.debtor.update({
      where: { id: debtorId },
      data: {
        status: 'REVISION',
        revision_reason: remarks,
        validation_remarks: remarks,
      },
    });

    // Create audit log
    try {
      await prisma.auditLog.create({
        data: {
          action: 'DEBTOR_REVISION',
          module: 'DEBTOR',
          entity_type: 'Debtor',
          entity_id: debtorId,
          old_value: JSON.stringify({ status: debtor.status }),
          new_value: JSON.stringify({ status: 'REVISION', remarks }),
          user_email: auditActor.user_email || 'system',
          user_role: auditActor.user_role || 'system',
          reason: remarks || `Debtor marked for revision by ${auditActor.user_email}`,
        },
      });
    } catch (auditError) {
      console.warn(`Failed to create audit log for debtor ${debtorId}:`, auditError);
    }

    const { emitNotification = true } = options;

    // Create notifications (skip when caller disables emitNotification)
    if (emitNotification) {
      try {
        for (const role of ALL_ROLES) {
          await prisma.notification.create({
            data: {
              title: 'Debtor Marked for Revision',
              message: `${auditActor.user_email || 'system'} marked debtor ${debtor.nama_peserta} for revision.`,
              type: 'WARNING',
              module: 'DEBTOR',
              reference_id: debtorId,
              target_role: role,
            },
          });
        }
      } catch (notifError) {
        console.warn(`Failed to create notifications for debtor ${debtorId}:`, notifError);
      }
    }

    return { success: true, debtorId, message: 'Debtor marked for revision successfully' };
  } catch (error) {
    console.error(`Error revising debtor ${debtorId}:`, error);
    return { success: false, debtorId, error: error.message };
  }
}

/**
 * Get aggregated status counts for the debtor review dashboard.
 * Replaces 5 separate paginated HTTP calls from the frontend.
 */
export async function getStatusCounts() {
  const [approvedBrins, checkedTugure, approved, revision] = await Promise.all([
    prisma.debtor.count({ where: { status: 'APPROVED_BRINS' } }),
    prisma.debtor.count({ where: { status: 'CHECKED_TUGURE' } }),
    prisma.debtor.count({ where: { status: 'APPROVED' } }),
    prisma.debtor.count({ where: { status: 'REVISION' } }),
  ]);
  const plafondAgg = await prisma.debtor.aggregate({
    _sum: { plafon: true },
    where: { status: 'APPROVED' },
  });
  return {
    pending: approvedBrins,
    checkedTugure,
    approved,
    revision,
    totalPlafond: parseFloat(plafondAgg._sum.plafon) || 0,
  };
}

/**
 * Get aggregate financial summary for a batch.
 * Replaces fetching all debtor rows + client-side reduce.
 */
export async function getBatchSummary(batchId) {
  const agg = await prisma.debtor.aggregate({
    _sum: { net_premi: true, ric_amount: true, plafon: true, nominal_premi: true },
    _count: { id: true },
    where: { batch_id: batchId },
  });
  const first = await prisma.debtor.findFirst({
    where: { batch_id: batchId },
    select: { contract_id: true },
  });
  return {
    totalNetPremi: parseFloat(agg._sum.net_premi) || 0,
    totalKomisi: parseFloat(agg._sum.ric_amount) || 0,
    totalPlafon: parseFloat(agg._sum.plafon) || 0,
    totalNominalPremi: parseFloat(agg._sum.nominal_premi) || 0,
    count: agg._count.id || 0,
    batchId,
    contractId: first?.contract_id || '-',
  };
}

/**
 * Process a list of debtor IDs through a Tugure-side workflow action.
 * action: 'check'  (APPROVED_BRINS → CHECKED_TUGURE)
 *       | 'approve' (CHECKED_TUGURE → APPROVED, creates Nota)
 *       | 'revise'  (CHECKED_TUGURE → REVISION)
 * Replaces N sequential backend.update calls on the frontend.
 */
export async function processBatchDebtorWorkflowAction(debtorIds, action, remarks = '', auditActor = {}) {
  let processedCount = 0;
  let failedCount = 0;
  const errors = [];
  let batchId = null;
  let contractId = null;
  let totalNetPremi = 0;

  for (const debtorId of debtorIds) {
    try {
      let result;
      if (action === 'check') {
        result = await processDebtorCheck(debtorId, auditActor, { emitNotification: false });
      } else if (action === 'approve') {
        const debtor = await prisma.debtor.findUnique({
          where: { id: debtorId },
          select: { batch_id: true, contract_id: true, net_premi: true },
        });
        if (debtor) {
          batchId = batchId || debtor.batch_id;
          contractId = contractId || debtor.contract_id;
          totalNetPremi += parseFloat(debtor.net_premi) || 0;
        }
        result = await processDebtorApproval(debtorId, remarks, auditActor, null, { emitNotification: false });
      } else if (action === 'revise') {
        result = await processDebtorRevision(debtorId, remarks, auditActor, { emitNotification: false });
      } else {
        throw new Error(`Unknown action: ${action}`);
      }
      if (result.success) processedCount++;
      else { failedCount++; errors.push({ debtorId, error: result.error }); }
    } catch (err) {
      failedCount++;
      errors.push({ debtorId, error: err.message });
    }
  }

  // Create single batch-level Nota on Tugure final approval
  if (action === 'approve' && processedCount > 0 && batchId && contractId) {
    try {
      const batchData = await prisma.batch.findUnique({ where: { batch_id: batchId } });
      const existing = await prisma.nota.findFirst({ where: { reference_id: batchId, nota_type: 'Batch' } });
      if (!existing) {
        await prisma.nota.create({
          data: {
            nota_number: `NOTA-${contractId}-${Date.now()}`,
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
            premium: parseFloat(batchData?.premium) || 0,
            commission: parseFloat(batchData?.commission) || 0,
            claim: parseFloat(batchData?.claim) || 0,
            total: parseFloat(batchData?.total) || 0,
            net_due: parseFloat(batchData?.net_due) || 0,
          },
        });
      }
    } catch (notaErr) {
      console.warn('Failed to create Nota for batch:', notaErr);
    }
  }

  // Single batch-level notification
  if (processedCount > 0) {
    const titleMap = { check: 'Checked by Tugure', approve: 'Approved (Final)', revise: 'Marked for Revision' };
    try {
      for (const role of ALL_ROLES) {
        await prisma.notification.create({
          data: {
            title: `Debtors ${titleMap[action] || action}`,
            message: `${auditActor.user_email || 'system'} performed ${action} on ${processedCount} debtor(s).`,
            type: action === 'revise' ? 'WARNING' : 'INFO',
            module: 'DEBTOR',
            reference_id: batchId || debtorIds[0],
            target_role: role,
          },
        });
      }
    } catch (notifErr) {
      console.warn('Failed to create batch notification:', notifErr);
    }
  }

  return { processedCount, failedCount, errors };
}

export default {
  processDebtorCheck,
  processDebtorApproval,
  processDebtorRevision,
  getStatusCounts,
  getBatchSummary,
  processBatchDebtorWorkflowAction,
};
