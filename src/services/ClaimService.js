import prisma from '../prisma/client.js';

/**
 * ClaimService: Encapsulates business logic for claim workflow actions.
 * Mirrors the 4-stage workflow: SUBMITTED → CHECKED_BRINS → APPROVED_BRINS → CHECKED_TUGURE → APPROVED
 * - BRINS checker/approver handle the first two stages
 * - TUGURE checker/approver handle the final two stages
 */

const ALL_ROLES = ['maker-brins-role', 'checker-brins-role', 'approver-brins-role', 'checker-tugure-role', 'approver-tugure-role'];

/**
 * Process single claim CHECK action
 * BRINS workflow: SUBMITTED → CHECKED_BRINS
 * TUGURE workflow: APPROVED_BRINS → CHECKED_TUGURE
 * @param {string} claimNo
 * @param {Object} auditActor - { user_email, user_role }
 * @param {Object} options
 */
export async function processClaimCheck(claimNo, auditActor = {}, options = {}) {
  try {
    const claim = await prisma.claim.findUnique({ where: { claim_no: claimNo } });
    if (!claim) throw new Error(`Claim ${claimNo} not found`);

    let newStatus, actionLabel, actionType;

    if (claim.status === 'SUBMITTED') {
      newStatus = 'CHECKED_BRINS';
      actionLabel = 'CLAIM_CHECKED_BRINS';
      actionType = 'BRINS Checker';
    } else if (claim.status === 'APPROVED_BRINS') {
      newStatus = 'CHECKED_TUGURE';
      actionLabel = 'CLAIM_CHECKED_TUGURE';
      actionType = 'TUGURE Checker';
    } else {
      throw new Error(`Claim ${claimNo} has invalid status: ${claim.status}, expected SUBMITTED or APPROVED_BRINS`);
    }

    const actorEmail = auditActor.user_email || 'system';

    await prisma.claim.update({
      where: { claim_no: claimNo },
      data: {
        status: newStatus,
        ...(newStatus === 'CHECKED_BRINS' ? { checked_by: actorEmail, checked_date: new Date() } : {}),
        ...(newStatus === 'CHECKED_TUGURE' ? { checked_by_tugure: actorEmail, checked_date_tugure: new Date() } : {}),
      },
    });

    try {
      await prisma.auditLog.create({
        data: {
          action: actionLabel,
          module: 'CLAIM',
          entity_type: 'Claim',
          entity_id: claimNo,
          old_value: JSON.stringify({ status: claim.status }),
          new_value: JSON.stringify({ status: newStatus }),
          user_email: actorEmail,
          user_role: auditActor.user_role || 'system',
          reason: `${actionType} checked claim ${claimNo}`,
        },
      });
    } catch (auditErr) {
      console.warn(`Failed to create audit log for claim ${claimNo}:`, auditErr);
    }

    const { emitNotification = true } = options;
    if (emitNotification) {
      try {
        for (const role of ALL_ROLES) {
          await prisma.notification.create({
            data: {
              title: newStatus === 'CHECKED_BRINS' ? 'Claim Checked by BRINS' : 'Claim Checked by TUGURE',
              message: `${actionType} (${actorEmail}) checked claim ${claimNo}.`,
              type: 'INFO',
              module: 'CLAIM',
              reference_id: claimNo,
              target_role: role,
            },
          });
        }
      } catch (notifErr) {
        console.warn(`Failed to create notifications for claim ${claimNo}:`, notifErr);
      }
    }

    return { success: true, claimNo, message: 'Claim checked successfully' };
  } catch (error) {
    console.error(`Error checking claim ${claimNo}:`, error);
    return { success: false, claimNo, error: error.message };
  }
}

/**
 * Process single claim APPROVAL action
 * BRINS workflow: CHECKED_BRINS → APPROVED_BRINS
 * TUGURE workflow: CHECKED_TUGURE → APPROVED (creates Nota)
 * @param {string} claimNo
 * @param {string} remarks
 * @param {Object} auditActor - { user_email, user_role }
 * @param {Object} options
 */
export async function processClaimApproval(claimNo, remarks = '', auditActor = {}, options = {}) {
  try {
    const claim = await prisma.claim.findUnique({ where: { claim_no: claimNo } });
    if (!claim) throw new Error(`Claim ${claimNo} not found`);

    let newStatus, actionLabel, actionType, createNota = false;

    if (claim.status === 'CHECKED_BRINS') {
      newStatus = 'APPROVED_BRINS';
      actionLabel = 'CLAIM_APPROVED_BRINS';
      actionType = 'BRINS Approver';
    } else if (claim.status === 'CHECKED_TUGURE') {
      newStatus = 'APPROVED';
      actionLabel = 'CLAIM_APPROVED';
      actionType = 'TUGURE Approver';
      createNota = true;
    } else {
      throw new Error(`Claim ${claimNo} has invalid status: ${claim.status}, expected CHECKED_BRINS or CHECKED_TUGURE`);
    }

    const actorEmail = auditActor.user_email || 'system';

    await prisma.claim.update({
      where: { claim_no: claimNo },
      data: {
        status: newStatus,
        ...(newStatus === 'APPROVED_BRINS' ? { approved_by_brins: actorEmail, approved_date_brins: new Date() } : {}),
        ...(newStatus === 'APPROVED' ? { approved_by: actorEmail, approved_date: new Date() } : {}),
      },
    });

    // Create Nota for final TUGURE approval
    if (createNota) {
      try {
        const notaNumber = `NOTA-${claimNo}-${Date.now()}`;
        const existing = await prisma.nota.findFirst({ where: { reference_id: claimNo } });
        if (!existing) {
          await prisma.nota.create({
            data: {
              nota_number: notaNumber,
              nota_type: 'Claim',
              reference_id: claimNo,
              contract_id: claim.contract_id || 'UNKNOWN',
              amount: parseFloat(claim.nilai_klaim) || 0,
              currency: 'IDR',
              status: 'UNPAID',
              issued_by: actorEmail,
              issued_date: new Date(),
              total_actual_paid: 0,
              reconciliation_status: 'PENDING',
              premium: 0,
              commission: 0,
              claim: parseFloat(claim.nilai_klaim) || 0,
              total: parseFloat(claim.nilai_klaim) || 0,
              net_due: parseFloat(claim.nilai_klaim) || 0,
            },
          });
        }
      } catch (notaErr) {
        console.warn(`Failed to create Nota for claim ${claimNo}:`, notaErr);
      }
    }

    try {
      await prisma.auditLog.create({
        data: {
          action: actionLabel,
          module: 'CLAIM',
          entity_type: 'Claim',
          entity_id: claimNo,
          old_value: JSON.stringify({ status: claim.status }),
          new_value: JSON.stringify({ status: newStatus, remarks }),
          user_email: actorEmail,
          user_role: auditActor.user_role || 'system',
          reason: remarks || `Claim approved by ${actorEmail}`,
        },
      });
    } catch (auditErr) {
      console.warn(`Failed to create audit log for claim ${claimNo}:`, auditErr);
    }

    const { emitNotification = true } = options;
    if (emitNotification) {
      try {
        for (const role of ALL_ROLES) {
          await prisma.notification.create({
            data: {
              title: newStatus === 'APPROVED_BRINS' ? 'Claim Approved by BRINS' : 'Claim Approved (Final)',
              message: `${actionType} (${actorEmail}) approved claim ${claimNo}.`,
              type: 'INFO',
              module: 'CLAIM',
              reference_id: claimNo,
              target_role: role,
            },
          });
        }
      } catch (notifErr) {
        console.warn(`Failed to create notifications for claim ${claimNo}:`, notifErr);
      }
    }

    return { success: true, claimNo, message: 'Claim approved successfully' };
  } catch (error) {
    console.error(`Error approving claim ${claimNo}:`, error);
    return { success: false, claimNo, error: error.message };
  }
}

/**
 * Process single claim REVISION action
 * CHECKED_TUGURE → REVISION
 * @param {string} claimNo
 * @param {string} remarks
 * @param {Object} auditActor - { user_email, user_role }
 * @param {Object} options
 */
export async function processClaimRevision(claimNo, remarks = '', auditActor = {}, options = {}) {
  try {
    const claim = await prisma.claim.findUnique({ where: { claim_no: claimNo } });
    if (!claim) throw new Error(`Claim ${claimNo} not found`);

    if (!['CHECKED_TUGURE', 'CHECKED_BRINS'].includes(claim.status)) {
      throw new Error(`Claim ${claimNo} has invalid status: ${claim.status}, expected CHECKED_BRINS or CHECKED_TUGURE`);
    }

    const actorEmail = auditActor.user_email || 'system';

    await prisma.claim.update({
      where: { claim_no: claimNo },
      data: { status: 'REVISION', revision_reason: remarks },
    });

    try {
      await prisma.auditLog.create({
        data: {
          action: 'CLAIM_REVISION',
          module: 'CLAIM',
          entity_type: 'Claim',
          entity_id: claimNo,
          old_value: JSON.stringify({ status: claim.status }),
          new_value: JSON.stringify({ status: 'REVISION', remarks }),
          user_email: actorEmail,
          user_role: auditActor.user_role || 'system',
          reason: remarks || `Claim marked for revision by ${actorEmail}`,
        },
      });
    } catch (auditErr) {
      console.warn(`Failed to create audit log for claim ${claimNo}:`, auditErr);
    }

    const { emitNotification = true } = options;
    if (emitNotification) {
      try {
        for (const role of ALL_ROLES) {
          await prisma.notification.create({
            data: {
              title: 'Claim Marked for Revision',
              message: `${actorEmail} marked claim ${claimNo} for revision.`,
              type: 'WARNING',
              module: 'CLAIM',
              reference_id: claimNo,
              target_role: role,
            },
          });
        }
      } catch (notifErr) {
        console.warn(`Failed to create notifications for claim ${claimNo}:`, notifErr);
      }
    }

    return { success: true, claimNo, message: 'Claim marked for revision successfully' };
  } catch (error) {
    console.error(`Error revising claim ${claimNo}:`, error);
    return { success: false, claimNo, error: error.message };
  }
}

export default { processClaimCheck, processClaimApproval, processClaimRevision };
