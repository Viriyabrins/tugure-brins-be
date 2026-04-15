import pLimit from 'p-limit';
import emailService from './EmailService.js';
import { getUsersByRole } from '../utils/keycloakUtils.js';

/**
 * WorkflowEmailService
 *
 * Centralised email dispatch for all workflow state transitions.
 * All public methods are fire-and-forget: call them without awaiting.
 *
 * Design decisions:
 * - Fire-and-forget: emails never block or fail the business transaction
 * - Retry once: on SMTP failure, wait 2 s and retry once, then log and give up
 * - Rate limit: max 5 concurrent SMTP connections at any time
 * - Keycloak role lookups happen at send-time (not cached), so recipient lists are always fresh
 */

const MAX_CONCURRENT = 5;
const limit = pLimit(MAX_CONCURRENT);

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Send one email with retry-once logic.
 * Returns silently on failure — never throws.
 */
async function sendWithRetry(payload) {
  try {
    await emailService.sendEmail(payload);
  } catch (firstErr) {
    console.warn(`[WorkflowEmail] First attempt failed (${payload.subject}): ${firstErr.message}. Retrying in 2 s…`);
    await new Promise(r => setTimeout(r, 2000));
    try {
      await emailService.sendEmail(payload);
    } catch (secondErr) {
      console.error(`[WorkflowEmail] Retry also failed (${payload.subject}): ${secondErr.message}. Giving up.`);
    }
  }
}

/**
 * Schedule a rate-limited send without blocking the caller.
 */
function schedule(payload) {
  limit(() => sendWithRetry(payload)).catch(() => {/* already swallowed inside sendWithRetry */});
}

/**
 * Fetch all emails for a Keycloak role. Returns an empty array on any failure.
 */
async function emailsForRole(realm, role) {
  try {
    const users = await getUsersByRole(realm, role);
    return users.map(u => u.email).filter(Boolean);
  } catch (err) {
    console.warn(`[WorkflowEmail] Could not fetch users for role ${role} in ${realm}: ${err.message}`);
    return [];
  }
}

/**
 * Send to a list of email addresses with the same subject/body.
 * Skips null/undefined/empty addresses silently.
 */
function sendToAll(addresses, subject, body) {
  const unique = [...new Set(addresses.filter(Boolean))];
  for (const to of unique) {
    schedule({ to: [to], subject, body });
  }
}

// ─── Module label helpers ─────────────────────────────────────────────────────

function moduleLabel(mod) {
  switch ((mod || '').toUpperCase()) {
    case 'MC':
    case 'MASTER_CONTRACT':
      return 'Master Contract';
    case 'CLAIM':
      return 'Claim';
    default:
      return 'Debtor Batch';
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Trigger emails after a batch/contract/claim is uploaded.
 *
 * Recipients:
 *   - Uploader (self / BRINS Maker)
 *   - All BRINS Checkers (Keycloak)
 *
 * @param {{ uploaderEmail: string, batchId: string, module: 'DEBTOR'|'MC'|'CLAIM', count?: number }} ctx
 */
export function sendUploadEmail({ uploaderEmail, batchId, module: mod, count }) {
  const label = moduleLabel(mod);
  const countText = count ? ` (${count} records)` : '';

  Promise.resolve().then(async () => {
    const checkers = await emailsForRole('brins', 'checker-brins-role');

    // Uploader self-notification
    if (uploaderEmail) {
      schedule({
        to: [uploaderEmail],
        subject: `You Have Successfully Uploaded ${label}`,
        body: `<p>Your ${label.toLowerCase()} upload for batch <strong>${batchId}</strong>${countText} has been submitted successfully and is awaiting BRINS Checker review.</p>`,
      });
    }

    // All BRINS Checkers
    sendToAll(checkers, `New ${label} Uploaded – Action Required`, `<p>A new ${label.toLowerCase()} batch <strong>${batchId}</strong>${countText} has been uploaded by ${uploaderEmail || 'a maker'} and is awaiting your review.</p>`);

    console.log(`[WorkflowEmail] ✓ Upload emails queued for batch ${batchId} (${mod})`);
  }).catch(err => console.error('[WorkflowEmail] sendUploadEmail error:', err.message));
}

/**
 * Trigger emails after a BRINS Checker reviews a document.
 *
 * Recipients:
 *   - Self (BRINS Checker)
 *   - Document uploader (DB field)
 *   - All BRINS Approvers (Keycloak)
 *
 * @param {{ actorEmail: string, uploaderEmail: string, batchId: string, module: string }} ctx
 */
export function sendCheckBrinsEmail({ actorEmail, uploaderEmail, batchId, module: mod }) {
  const label = moduleLabel(mod);

  Promise.resolve().then(async () => {
    const approvers = await emailsForRole('brins', 'approver-brins-role');

    // Self
    if (actorEmail) {
      schedule({
        to: [actorEmail],
        subject: `You Have Successfully Checked ${label}`,
        body: `<p>You have successfully reviewed ${label.toLowerCase()} batch <strong>${batchId}</strong>. It is now awaiting BRINS Approver sign-off.</p>`,
      });
    }

    // Uploader
    if (uploaderEmail) {
      schedule({
        to: [uploaderEmail],
        subject: `Your ${label} Has Been Checked by BRINS`,
        body: `<p>${actorEmail || 'A BRINS Checker'} has reviewed ${label.toLowerCase()} batch <strong>${batchId}</strong>. It is now pending BRINS approval.</p>`,
      });
    }

    // All BRINS Approvers
    sendToAll(approvers, `${label} Ready for BRINS Approval – Batch ${batchId}`, `<p>${label} batch <strong>${batchId}</strong> has been checked by ${actorEmail || 'a BRINS Checker'} and is awaiting your approval.</p>`);

    console.log(`[WorkflowEmail] ✓ Check-BRINS emails queued for batch ${batchId} (${mod})`);
  }).catch(err => console.error('[WorkflowEmail] sendCheckBrinsEmail error:', err.message));
}

/**
 * Trigger emails after a BRINS Approver approves a document.
 *
 * Recipients:
 *   - Self (BRINS Approver)
 *   - Document uploader (DB field) — note about nota premi if debtor/claim
 *   - Document checker BRINS (DB field)
 *   - All TUGURE Checkers (Keycloak)
 *
 * @param {{ actorEmail: string, uploaderEmail: string, checkerEmail: string, batchId: string, module: string }} ctx
 */
export function sendApproveBrinsEmail({ actorEmail, uploaderEmail, checkerEmail, batchId, module: mod }) {
  const label = moduleLabel(mod);
  const isDebtorOrClaim = mod !== 'MC' && mod !== 'MASTER_CONTRACT';

  Promise.resolve().then(async () => {
    const tugureCheckers = await emailsForRole('tugure', 'tugure-checker-role');

    // Self
    if (actorEmail) {
      schedule({
        to: [actorEmail],
        subject: `You Have Successfully Approved ${label}`,
        body: `<p>You have approved ${label.toLowerCase()} batch <strong>${batchId}</strong>. It has been forwarded to TUGURE Checker for review.</p>`,
      });
    }

    // Uploader
    if (uploaderEmail) {
      const uploaderNote = isDebtorOrClaim
        ? `<p>A nota premi has been generated for batch <strong>${batchId}</strong>. It is now pending TUGURE review.</p>`
        : `<p>${label} batch <strong>${batchId}</strong> has been approved by BRINS and is now pending TUGURE review.</p>`;
      schedule({
        to: [uploaderEmail],
        subject: `Your ${label} Has Been Approved by BRINS – Batch ${batchId}`,
        body: uploaderNote,
      });
    }

    // BRINS Checker
    if (checkerEmail) {
      schedule({
        to: [checkerEmail],
        subject: `${label} Approved by BRINS – Batch ${batchId}`,
        body: `<p>${actorEmail || 'A BRINS Approver'} has approved ${label.toLowerCase()} batch <strong>${batchId}</strong>. It is now pending TUGURE review.</p>`,
      });
    }

    // All TUGURE Checkers
    sendToAll(tugureCheckers, `${label} Ready for TUGURE Review – Batch ${batchId}`, `<p>${label} batch <strong>${batchId}</strong> has been approved by BRINS and is awaiting your review.</p>`);

    console.log(`[WorkflowEmail] ✓ Approve-BRINS emails queued for batch ${batchId} (${mod})`);
  }).catch(err => console.error('[WorkflowEmail] sendApproveBrinsEmail error:', err.message));
}

/**
 * Trigger emails after a TUGURE Checker reviews a document.
 *
 * Recipients:
 *   - Self (TUGURE Checker)
 *   - Document uploader (BRINS Maker, DB field)
 *   - Document checker BRINS (DB field)
 *   - Document approver BRINS (DB field)
 *   - All TUGURE Approvers (Keycloak)
 *
 * @param {{ actorEmail: string, uploaderEmail: string, checkerBrinsEmail: string, approverBrinsEmail: string, batchId: string, module: string }} ctx
 */
export function sendCheckTugureEmail({ actorEmail, uploaderEmail, checkerBrinsEmail, approverBrinsEmail, batchId, module: mod }) {
  const label = moduleLabel(mod);

  Promise.resolve().then(async () => {
    const tugureApprovers = await emailsForRole('tugure', 'tugure-approver-role');

    // Self
    if (actorEmail) {
      schedule({
        to: [actorEmail],
        subject: `You Have Successfully Checked ${label} at TUGURE`,
        body: `<p>You have reviewed ${label.toLowerCase()} batch <strong>${batchId}</strong>. It is now pending TUGURE final approval.</p>`,
      });
    }

    // BRINS actors (uploader, checker, approver)
    const brinsRecipients = [uploaderEmail, checkerBrinsEmail, approverBrinsEmail];
    sendToAll(brinsRecipients, `${label} Checked by TUGURE – Batch ${batchId}`, `<p>TUGURE Checker ${actorEmail || ''} has reviewed ${label.toLowerCase()} batch <strong>${batchId}</strong>. It is now pending TUGURE final approval.</p>`);

    // All TUGURE Approvers
    sendToAll(tugureApprovers, `${label} Ready for TUGURE Final Approval – Batch ${batchId}`, `<p>${label} batch <strong>${batchId}</strong> has been checked by ${actorEmail || 'a TUGURE Checker'} and is awaiting your final approval.</p>`);

    console.log(`[WorkflowEmail] ✓ Check-TUGURE emails queued for batch ${batchId} (${mod})`);
  }).catch(err => console.error('[WorkflowEmail] sendCheckTugureEmail error:', err.message));
}

/**
 * Trigger emails after a TUGURE Approver gives final approval.
 *
 * Recipients:
 *   - Self (TUGURE Approver)
 *   - Document uploader (BRINS Maker) — note about contract ready if MC
 *   - Document checker BRINS (DB field)
 *   - Document approver BRINS (DB field)
 *   - Document checker TUGURE (DB field)
 *
 * @param {{ actorEmail: string, uploaderEmail: string, checkerBrinsEmail: string, approverBrinsEmail: string, checkerTugureEmail: string, batchId: string, module: string }} ctx
 */
export function sendApproveFinalEmail({ actorEmail, uploaderEmail, checkerBrinsEmail, approverBrinsEmail, checkerTugureEmail, batchId, module: mod }) {
  const label = moduleLabel(mod);
  const isMC = mod === 'MC' || mod === 'MASTER_CONTRACT';

  Promise.resolve().then(async () => {
    // Self
    if (actorEmail) {
      schedule({
        to: [actorEmail],
        subject: `You Have Given Final Approval for ${label} – Batch ${batchId}`,
        body: `<p>You have given final approval for ${label.toLowerCase()} batch <strong>${batchId}</strong>.</p>`,
      });
    }

    // Uploader — different message for MC
    if (uploaderEmail) {
      const uploaderBody = isMC
        ? `<p>Your master contract (batch <strong>${batchId}</strong>) has received final TUGURE approval. The contract is now active and ready to be used for debtor list uploads.</p>`
        : `<p>${label} batch <strong>${batchId}</strong> has received final TUGURE approval from ${actorEmail || 'a TUGURE Approver'}.</p>`;
      schedule({
        to: [uploaderEmail],
        subject: isMC ? `Master Contract Approved – Ready for Debtor Upload (Batch ${batchId})` : `${label} Finally Approved – Batch ${batchId}`,
        body: uploaderBody,
      });
    }

    // BRINS checker, BRINS approver, TUGURE checker
    const priorActors = [checkerBrinsEmail, approverBrinsEmail, checkerTugureEmail];
    sendToAll(priorActors, `${label} Finally Approved – Batch ${batchId}`, `<p>${label} batch <strong>${batchId}</strong> has received final TUGURE approval from ${actorEmail || 'a TUGURE Approver'}.</p>`);

    console.log(`[WorkflowEmail] ✓ Approve-Final emails queued for batch ${batchId} (${mod})`);
  }).catch(err => console.error('[WorkflowEmail] sendApproveFinalEmail error:', err.message));
}

/**
 * Trigger email after a document is sent for revision.
 *
 * Recipients:
 *   - Document uploader only (DB field)
 *
 * @param {{ uploaderEmail: string, batchId: string, module: string, remarks?: string }} ctx
 */
export function sendRevisionEmail({ uploaderEmail, batchId, module: mod, remarks }) {
  const label = moduleLabel(mod);

  if (!uploaderEmail) {
    console.warn(`[WorkflowEmail] sendRevisionEmail: no uploaderEmail for batch ${batchId}, skipping.`);
    return;
  }

  const remarksText = remarks ? `<p><strong>Remarks:</strong> ${remarks}</p>` : '';
  schedule({
    to: [uploaderEmail],
    subject: `${label} Sent for Revision – Batch ${batchId}`,
    body: `<p>Your ${label.toLowerCase()} batch <strong>${batchId}</strong> has been sent for revision. Please review the remarks and re-submit.</p>${remarksText}`,
  });

  console.log(`[WorkflowEmail] ✓ Revision email queued for batch ${batchId} (${mod})`);
}
