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

/**
 * Get the highest existing sequence number for claims with a given prefix.
 * Replaces fetching 9999 claims + client-side iteration on the frontend.
 */
export async function getNextClaimSequence(prefix) {
  if (!prefix) return 0;
  const latest = await prisma.claim.findFirst({
    where: { claim_no: { startsWith: prefix } },
    orderBy: { claim_no: 'desc' },
    select: { claim_no: true },
  });
  if (!latest?.claim_no) return 0;
  const seq = parseInt(latest.claim_no.replace(prefix, ''), 10);
  return isNaN(seq) ? 0 : seq;
}

/**
 * Create a Subrogation entry with audit log and notifications.
 * Replaces frontend backend.create("Subrogation", ...) + audit + notify calls.
 */
export async function createSubrogationEntry(data = {}, auditActor = {}) {
  const subrogationId = `SUB-${Date.now()}`;
  await prisma.subrogation.create({
    data: {
      subrogation_id: subrogationId,
      claim_id: data.claimId || '',
      debtor_id: data.debtorId || '',
      recovery_amount: parseFloat(data.recoveryAmount) || 0,
      recovery_date: data.recoveryDate ? new Date(data.recoveryDate) : null,
      status: 'SUBMITTED',
      remarks: data.remarks || '',
    },
  });
  try {
    await prisma.auditLog.create({
      data: {
        action: 'SUBROGATION_CREATED',
        module: 'SUBROGATION',
        entity_type: 'Subrogation',
        entity_id: subrogationId,
        old_value: '{}',
        new_value: JSON.stringify({ claim_id: data.claimId, recovery_amount: data.recoveryAmount }),
        user_email: auditActor.user_email || 'system',
        user_role: auditActor.user_role || 'system',
        reason: 'Manual subrogation creation',
      },
    });
  } catch (e) { console.warn('Subrogation audit failed:', e); }
  try {
    for (const role of ALL_ROLES) {
      await prisma.notification.create({
        data: {
          title: 'New Subrogation Created',
          message: `Subrogation ${subrogationId} created for claim ${data.claimId}`,
          type: 'INFO',
          module: 'SUBROGATION',
          reference_id: subrogationId,
          target_role: role,
        },
      });
    }
  } catch (e) { console.warn('Subrogation notification failed:', e); }
  return subrogationId;
}

/**
 * Process a subrogation workflow action: 'check', 'approve', or 'revise'.
 * 'approve' creates a Nota, updates Subrogation status, and notifies.
 * Returns the nota_number for 'approve', undefined otherwise.
 */
export async function processSubrogationWorkflow(subId, action, data = {}, auditActor = {}) {
  const sub = await prisma.subrogation.findUnique({ where: { subrogation_id: subId } });
  if (!sub) throw new Error(`Subrogation ${subId} not found`);
  const actorEmail = auditActor.user_email || 'system';

  if (action === 'check') {
    await prisma.subrogation.update({
      where: { subrogation_id: subId },
      data: { status: 'CHECKED', checked_by: actorEmail, checked_date: new Date(), reviewed_by: actorEmail, review_date: new Date() },
    });
    try {
      await prisma.auditLog.create({
        data: {
          action: 'SUBROGATION_CHECK', module: 'SUBROGATION', entity_type: 'Subrogation', entity_id: subId,
          old_value: JSON.stringify({ status: sub.status }), new_value: JSON.stringify({ status: 'CHECKED' }),
          user_email: actorEmail, user_role: auditActor.user_role || 'system', reason: '',
        },
      });
    } catch (e) { console.warn('Audit failed:', e); }

  } else if (action === 'approve') {
    const { contractId = '', recoveryAmount, remarks = '' } = data;
    const amount = parseFloat(recoveryAmount ?? sub.recovery_amount) || 0;
    const notaNumber = `NOTA-SBR-${subId}-${Date.now()}`;
    try {
      await prisma.nota.create({
        data: {
          nota_number: notaNumber, nota_type: 'Subrogation', reference_id: subId,
          contract_id: contractId, amount, currency: 'IDR', status: 'UNPAID',
          issued_by: actorEmail, issued_date: new Date(), is_immutable: false,
          total_actual_paid: 0, reconciliation_status: 'PENDING',
          premium: 0, commission: 0, claim: amount, total: amount, net_due: amount,
        },
      });
    } catch (e) { console.warn('Failed to create Nota for subrogation:', e); }
    await prisma.subrogation.update({
      where: { subrogation_id: subId },
      data: {
        status: 'APPROVED', approved_by: actorEmail, approved_date: new Date(),
        invoiced_by: actorEmail, invoiced_date: new Date(),
        ...(remarks ? { remarks } : {}),
      },
    });
    try {
      for (const role of ALL_ROLES) {
        await prisma.notification.create({
          data: {
            title: 'Subrogation Nota Generated',
            message: `Nota ${notaNumber} created for Subrogation ${subId}. Remarks: ${remarks || '-'}`,
            type: 'ACTION_REQUIRED', module: 'SUBROGATION', reference_id: subId, target_role: role,
          },
        });
      }
    } catch (e) { console.warn('Notification failed:', e); }
    try {
      await prisma.auditLog.create({
        data: {
          action: 'SUBROGATION_APPROVE', module: 'SUBROGATION', entity_type: 'Subrogation', entity_id: subId,
          old_value: JSON.stringify({ status: sub.status }), new_value: JSON.stringify({ status: 'APPROVED' }),
          user_email: actorEmail, user_role: auditActor.user_role || 'system', reason: remarks,
        },
      });
    } catch (e) { console.warn('Audit failed:', e); }
    return notaNumber;

  } else if (action === 'revise') {
    const { remarks = '' } = data;
    await prisma.subrogation.update({ where: { subrogation_id: subId }, data: { status: 'REVISION', remarks } });
    try {
      await prisma.auditLog.create({
        data: {
          action: 'SUBROGATION_REVISE', module: 'SUBROGATION', entity_type: 'Subrogation', entity_id: subId,
          old_value: JSON.stringify({ status: sub.status }), new_value: JSON.stringify({ status: 'REVISION' }),
          user_email: actorEmail, user_role: auditActor.user_role || 'system', reason: remarks,
        },
      });
    } catch (e) { console.warn('Audit failed:', e); }

  } else {
    throw new Error(`Unknown subrogation action: ${action}`);
  }
}

/**
 * Fetch all context data needed by the claim review page in one round-trip.
 * Replaces 5 parallel backend.list calls from the frontend.
 */
export async function getClaimReviewContext() {
  const [subrogations, notas, contracts, debtors, batches] = await Promise.all([
    prisma.subrogation.findMany(),
    prisma.nota.findMany(),
    prisma.contract.findMany(),
    prisma.debtor.findMany(),
    prisma.batch.findMany(),
  ]);
  return { subrogations, notas, contracts, debtors, batches };
}

export default { processClaimCheck, processClaimApproval, processClaimRevision, getNextClaimSequence, createSubrogationEntry, processSubrogationWorkflow, getClaimReviewContext };
