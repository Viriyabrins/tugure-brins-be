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

export default {
  processDebtorCheck,
  processDebtorApproval,
  processDebtorRevision,
};
