import pLimit from 'p-limit';
import emailService from './EmailService.js';
import { getUsersByRole } from '../utils/keycloakUtils.js';
import {
  WORKFLOW_ACTIONS,
  WORKFLOW_AUDIENCES,
  getWorkflowTemplate,
  moduleLabel,
  moduleToObjectType,
  replaceTemplateVariables,
} from './WorkflowEmailTemplateService.js';

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
 * - Workflow email templates are loaded from EmailTemplate first, then hardcoded content is used as fallback
 */

const MAX_CONCURRENT = 5;
const limit = pLimit(MAX_CONCURRENT);

async function sendWithRetry(payload) {
  try {
    await emailService.sendEmail(payload);
  } catch (firstErr) {
    console.warn(`[WorkflowEmail] First attempt failed (${payload.subject}): ${firstErr.message}. Retrying in 2 s...`);
    await new Promise((r) => setTimeout(r, 2000));
    try {
      await emailService.sendEmail(payload);
    } catch (secondErr) {
      console.error(`[WorkflowEmail] Retry also failed (${payload.subject}): ${secondErr.message}. Giving up.`);
    }
  }
}

function schedule(payload) {
  limit(() => sendWithRetry(payload)).catch(() => {});
}

async function emailsForRole(realm, role) {
  try {
    const users = await getUsersByRole(realm, role);
    return users.map((u) => u.email).filter(Boolean);
  } catch (err) {
    console.warn(`[WorkflowEmail] Could not fetch users for role ${role} in ${realm}: ${err.message}`);
    return [];
  }
}

function scheduleToAll(addresses, subject, body) {
  const unique = [...new Set(addresses.filter(Boolean))];
  for (const to of unique) {
    schedule({ to: [to], subject, body });
  }
}

function buildVariables(ctx = {}, defaults = {}) {
  const module_label = moduleLabel(ctx.module);
  const countValue = Number(ctx.count);
  const recordCount = Number.isFinite(countValue) && countValue > 0 ? String(countValue) : '';
  const normalizedRemarks = String(ctx.remarks || '').trim();

  return {
    batch_id: ctx.batchId || '',
    actor_email: ctx.actorEmail || '',
    uploader_email: ctx.uploaderEmail || '',
    checker_email: ctx.checkerEmail || '',
    checker_brins_email: ctx.checkerBrinsEmail || '',
    approver_brins_email: ctx.approverBrinsEmail || '',
    checker_tugure_email: ctx.checkerTugureEmail || '',
    module_label,
    module_label_lower: module_label.toLowerCase(),
    object_type: moduleToObjectType(ctx.module),
    record_count: recordCount,
    record_count_text: recordCount ? ` (${recordCount} records)` : '',
    remarks: normalizedRemarks,
    remarks_block: normalizedRemarks ? `<p><strong>Remarks:</strong> ${normalizedRemarks}</p>` : '',
    actor_display: defaults.actorDisplay || ctx.actorEmail || '',
    actor_display_lower: defaults.actorDisplayLower || defaults.actorDisplay || ctx.actorEmail || '',
    uploader_display: defaults.uploaderDisplay || ctx.uploaderEmail || '',
  };
}

async function resolveTemplateContent({ workflowAction, workflowAudience, ctx, fallbackSubject, fallbackBody, defaults = {} }) {
  const objectType = moduleToObjectType(ctx.module);
  const variables = buildVariables(ctx, defaults);

  try {
    const template = await getWorkflowTemplate({ objectType, workflowAction, workflowAudience });
    if (template) {
      console.log(
        `[WorkflowEmail][Template] Using DB template for ${objectType}/${workflowAction}/${workflowAudience} on batch ${ctx.batchId}`
      );
      return {
        subject: replaceTemplateVariables(template.email_subject, variables),
        body: replaceTemplateVariables(template.email_body, variables),
      };
    }
  } catch (err) {
    console.warn(
      `[WorkflowEmail] Template lookup failed for ${objectType}/${workflowAction}/${workflowAudience}: ${err.message}`
    );
  }

  console.log(
    `[WorkflowEmail][Template] Falling back to hardcoded content for ${objectType}/${workflowAction}/${workflowAudience} on batch ${ctx.batchId}`
  );

  return {
    subject: replaceTemplateVariables(fallbackSubject, variables),
    body: replaceTemplateVariables(fallbackBody, variables),
  };
}

async function scheduleRenderedEmail({ addresses, workflowAction, workflowAudience, ctx, fallbackSubject, fallbackBody, defaults }) {
  const unique = [...new Set((Array.isArray(addresses) ? addresses : [addresses]).filter(Boolean))];
  if (unique.length === 0) return;

  const { subject, body } = await resolveTemplateContent({
    workflowAction,
    workflowAudience,
    ctx,
    fallbackSubject,
    fallbackBody,
    defaults,
  });

  if (!subject || !body) {
    console.warn(`[WorkflowEmail] Missing content for ${workflowAction}/${workflowAudience} on ${ctx.batchId}.`);
    return;
  }

  scheduleToAll(unique, subject, body);
}

export function sendUploadEmail({ uploaderEmail, batchId, module: mod, count }) {
  const label = moduleLabel(mod);
  const countText = count ? ` (${count} records)` : '';
  const ctx = { uploaderEmail, batchId, module: mod, count };

  Promise.resolve()
    .then(async () => {
      const checkers = await emailsForRole('brins', 'checker-brins-role');

      if (uploaderEmail) {
        await scheduleRenderedEmail({
          addresses: [uploaderEmail],
          workflowAction: WORKFLOW_ACTIONS.UPLOAD,
          workflowAudience: WORKFLOW_AUDIENCES.UPLOADER,
          ctx,
          fallbackSubject: `You Have Successfully Uploaded ${label}`,
          fallbackBody: `<p>Your ${label.toLowerCase()} upload for batch <strong>{batch_id}</strong>${countText} has been submitted successfully and is awaiting BRINS Checker review.</p>`,
        });
      }

      await scheduleRenderedEmail({
        addresses: checkers,
        workflowAction: WORKFLOW_ACTIONS.UPLOAD,
        workflowAudience: WORKFLOW_AUDIENCES.BRINS_CHECKERS,
        ctx,
        fallbackSubject: `New ${label} Uploaded - Action Required`,
        fallbackBody: `<p>A new ${label.toLowerCase()} batch <strong>{batch_id}</strong>${countText} has been uploaded by {uploader_display} and is awaiting your review.</p>`,
        defaults: { uploaderDisplay: uploaderEmail || 'a maker' },
      });

      console.log(`[WorkflowEmail] ✓ Upload emails queued for batch ${batchId} (${mod})`);
    })
    .catch((err) => console.error('[WorkflowEmail] sendUploadEmail error:', err.message));
}

export function sendCheckBrinsEmail({ actorEmail, uploaderEmail, batchId, module: mod }) {
  const label = moduleLabel(mod);
  const ctx = { actorEmail, uploaderEmail, batchId, module: mod };

  Promise.resolve()
    .then(async () => {
      const approvers = await emailsForRole('brins', 'approver-brins-role');

      if (actorEmail) {
        await scheduleRenderedEmail({
          addresses: [actorEmail],
          workflowAction: WORKFLOW_ACTIONS.CHECK_BRINS,
          workflowAudience: WORKFLOW_AUDIENCES.ACTOR_SELF,
          ctx,
          fallbackSubject: `You Have Successfully Checked ${label}`,
          fallbackBody: `<p>You have successfully reviewed ${label.toLowerCase()} batch <strong>{batch_id}</strong>. It is now awaiting BRINS Approver sign-off.</p>`,
        });
      }

      if (uploaderEmail) {
        await scheduleRenderedEmail({
          addresses: [uploaderEmail],
          workflowAction: WORKFLOW_ACTIONS.CHECK_BRINS,
          workflowAudience: WORKFLOW_AUDIENCES.UPLOADER,
          ctx,
          fallbackSubject: `Your ${label} Has Been Checked by BRINS`,
          fallbackBody: `<p>{actor_display} has reviewed ${label.toLowerCase()} batch <strong>{batch_id}</strong>. It is now pending BRINS approval.</p>`,
          defaults: { actorDisplay: actorEmail || 'A BRINS Checker' },
        });
      }

      await scheduleRenderedEmail({
        addresses: approvers,
        workflowAction: WORKFLOW_ACTIONS.CHECK_BRINS,
        workflowAudience: WORKFLOW_AUDIENCES.BRINS_APPROVERS,
        ctx,
        fallbackSubject: `${label} Ready for BRINS Approval - Batch {batch_id}`,
        fallbackBody: `<p>${label} batch <strong>{batch_id}</strong> has been checked by {actor_display_lower} and is awaiting your approval.</p>`,
        defaults: { actorDisplayLower: actorEmail || 'a BRINS Checker' },
      });

      console.log(`[WorkflowEmail] ✓ Check-BRINS emails queued for batch ${batchId} (${mod})`);
    })
    .catch((err) => console.error('[WorkflowEmail] sendCheckBrinsEmail error:', err.message));
}

export function sendApproveBrinsEmail({ actorEmail, uploaderEmail, checkerEmail, batchId, module: mod }) {
  const label = moduleLabel(mod);
  const isDebtorOrClaim = mod !== 'MC' && mod !== 'MASTER_CONTRACT';
  const ctx = { actorEmail, uploaderEmail, checkerEmail, batchId, module: mod };

  Promise.resolve()
    .then(async () => {
      const tugureCheckers = await emailsForRole('tugure', 'tugure-checker-role');

      if (actorEmail) {
        await scheduleRenderedEmail({
          addresses: [actorEmail],
          workflowAction: WORKFLOW_ACTIONS.APPROVE_BRINS,
          workflowAudience: WORKFLOW_AUDIENCES.ACTOR_SELF,
          ctx,
          fallbackSubject: `You Have Successfully Approved ${label}`,
          fallbackBody: `<p>You have approved ${label.toLowerCase()} batch <strong>{batch_id}</strong>. It has been forwarded to TUGURE Checker for review.</p>`,
        });
      }

      if (uploaderEmail) {
        await scheduleRenderedEmail({
          addresses: [uploaderEmail],
          workflowAction: WORKFLOW_ACTIONS.APPROVE_BRINS,
          workflowAudience: WORKFLOW_AUDIENCES.UPLOADER,
          ctx,
          fallbackSubject: `Your ${label} Has Been Approved by BRINS - Batch {batch_id}`,
          fallbackBody: isDebtorOrClaim
            ? `<p>A nota premi has been generated for batch <strong>{batch_id}</strong>. It is now pending TUGURE review.</p>`
            : `<p>${label} batch <strong>{batch_id}</strong> has been approved by BRINS and is now pending TUGURE review.</p>`,
        });
      }

      if (checkerEmail) {
        await scheduleRenderedEmail({
          addresses: [checkerEmail],
          workflowAction: WORKFLOW_ACTIONS.APPROVE_BRINS,
          workflowAudience: WORKFLOW_AUDIENCES.PRIOR_ACTORS,
          ctx,
          fallbackSubject: `${label} Approved by BRINS - Batch {batch_id}`,
          fallbackBody: `<p>{actor_display} has approved ${label.toLowerCase()} batch <strong>{batch_id}</strong>. It is now pending TUGURE review.</p>`,
          defaults: { actorDisplay: actorEmail || 'A BRINS Approver' },
        });
      }

      await scheduleRenderedEmail({
        addresses: tugureCheckers,
        workflowAction: WORKFLOW_ACTIONS.APPROVE_BRINS,
        workflowAudience: WORKFLOW_AUDIENCES.TUGURE_CHECKERS,
        ctx,
        fallbackSubject: `${label} Ready for TUGURE Review - Batch {batch_id}`,
        fallbackBody: `<p>${label} batch <strong>{batch_id}</strong> has been approved by BRINS and is awaiting your review.</p>`,
      });

      console.log(`[WorkflowEmail] ✓ Approve-BRINS emails queued for batch ${batchId} (${mod})`);
    })
    .catch((err) => console.error('[WorkflowEmail] sendApproveBrinsEmail error:', err.message));
}

export function sendCheckTugureEmail({
  actorEmail,
  uploaderEmail,
  checkerBrinsEmail,
  approverBrinsEmail,
  batchId,
  module: mod,
}) {
  const label = moduleLabel(mod);
  const ctx = { actorEmail, uploaderEmail, checkerBrinsEmail, approverBrinsEmail, batchId, module: mod };

  Promise.resolve()
    .then(async () => {
      const tugureApprovers = await emailsForRole('tugure', 'tugure-approver-role');

      if (actorEmail) {
        await scheduleRenderedEmail({
          addresses: [actorEmail],
          workflowAction: WORKFLOW_ACTIONS.CHECK_TUGURE,
          workflowAudience: WORKFLOW_AUDIENCES.ACTOR_SELF,
          ctx,
          fallbackSubject: `You Have Successfully Checked ${label} at TUGURE`,
          fallbackBody: `<p>You have reviewed ${label.toLowerCase()} batch <strong>{batch_id}</strong>. It is now pending TUGURE final approval.</p>`,
        });
      }

      await scheduleRenderedEmail({
        addresses: [uploaderEmail, checkerBrinsEmail, approverBrinsEmail],
        workflowAction: WORKFLOW_ACTIONS.CHECK_TUGURE,
        workflowAudience: WORKFLOW_AUDIENCES.PRIOR_ACTORS,
        ctx,
        fallbackSubject: `${label} Checked by TUGURE - Batch {batch_id}`,
        fallbackBody: `<p>{actor_display} has reviewed ${label.toLowerCase()} batch <strong>{batch_id}</strong>. It is now pending TUGURE final approval.</p>`,
        defaults: { actorDisplay: actorEmail || 'TUGURE Checker' },
      });

      await scheduleRenderedEmail({
        addresses: tugureApprovers,
        workflowAction: WORKFLOW_ACTIONS.CHECK_TUGURE,
        workflowAudience: WORKFLOW_AUDIENCES.TUGURE_APPROVERS,
        ctx,
        fallbackSubject: `${label} Ready for TUGURE Final Approval - Batch {batch_id}`,
        fallbackBody: `<p>${label} batch <strong>{batch_id}</strong> has been checked by {actor_display_lower} and is awaiting your final approval.</p>`,
        defaults: { actorDisplayLower: actorEmail || 'a TUGURE Checker' },
      });

      console.log(`[WorkflowEmail] ✓ Check-TUGURE emails queued for batch ${batchId} (${mod})`);
    })
    .catch((err) => console.error('[WorkflowEmail] sendCheckTugureEmail error:', err.message));
}

export function sendApproveFinalEmail({
  actorEmail,
  uploaderEmail,
  checkerBrinsEmail,
  approverBrinsEmail,
  checkerTugureEmail,
  batchId,
  module: mod,
}) {
  const label = moduleLabel(mod);
  const isMC = mod === 'MC' || mod === 'MASTER_CONTRACT';
  const ctx = { actorEmail, uploaderEmail, checkerBrinsEmail, approverBrinsEmail, checkerTugureEmail, batchId, module: mod };

  Promise.resolve()
    .then(async () => {
      if (actorEmail) {
        await scheduleRenderedEmail({
          addresses: [actorEmail],
          workflowAction: WORKFLOW_ACTIONS.APPROVE_FINAL,
          workflowAudience: WORKFLOW_AUDIENCES.ACTOR_SELF,
          ctx,
          fallbackSubject: `You Have Given Final Approval for ${label} - Batch {batch_id}`,
          fallbackBody: `<p>You have given final approval for ${label.toLowerCase()} batch <strong>{batch_id}</strong>.</p>`,
        });
      }

      if (uploaderEmail) {
        await scheduleRenderedEmail({
          addresses: [uploaderEmail],
          workflowAction: WORKFLOW_ACTIONS.APPROVE_FINAL,
          workflowAudience: WORKFLOW_AUDIENCES.UPLOADER,
          ctx,
          fallbackSubject: isMC
            ? `Master Contract Approved - Ready for Debtor Upload (Batch {batch_id})`
            : `${label} Finally Approved - Batch {batch_id}`,
          fallbackBody: isMC
            ? `<p>Your master contract (batch <strong>{batch_id}</strong>) has received final TUGURE approval. The contract is now active and ready to be used for debtor list uploads.</p>`
            : `<p>${label} batch <strong>{batch_id}</strong> has received final TUGURE approval from {actor_display_lower}.</p>`,
          defaults: { actorDisplayLower: actorEmail || 'a TUGURE Approver' },
        });
      }

      await scheduleRenderedEmail({
        addresses: [checkerBrinsEmail, approverBrinsEmail, checkerTugureEmail],
        workflowAction: WORKFLOW_ACTIONS.APPROVE_FINAL,
        workflowAudience: WORKFLOW_AUDIENCES.PRIOR_ACTORS,
        ctx,
        fallbackSubject: `${label} Finally Approved - Batch {batch_id}`,
        fallbackBody: `<p>${label} batch <strong>{batch_id}</strong> has received final TUGURE approval from {actor_display_lower}.</p>`,
        defaults: { actorDisplayLower: actorEmail || 'a TUGURE Approver' },
      });

      console.log(`[WorkflowEmail] ✓ Approve-Final emails queued for batch ${batchId} (${mod})`);
    })
    .catch((err) => console.error('[WorkflowEmail] sendApproveFinalEmail error:', err.message));
}

export function sendRevisionEmail({ uploaderEmail, batchId, module: mod, remarks }) {
  const label = moduleLabel(mod);
  const ctx = { uploaderEmail, batchId, module: mod, remarks };

  if (!uploaderEmail) {
    console.warn(`[WorkflowEmail] sendRevisionEmail: no uploaderEmail for batch ${batchId}, skipping.`);
    return;
  }

  Promise.resolve()
    .then(async () => {
      await scheduleRenderedEmail({
        addresses: [uploaderEmail],
        workflowAction: WORKFLOW_ACTIONS.REVISION,
        workflowAudience: WORKFLOW_AUDIENCES.UPLOADER,
        ctx,
        fallbackSubject: `${label} Sent for Revision - Batch {batch_id}`,
        fallbackBody: `<p>Your ${label.toLowerCase()} batch <strong>{batch_id}</strong> has been sent for revision. Please review the remarks and re-submit.</p>{remarks_block}`,
      });

      console.log(`[WorkflowEmail] ✓ Revision email queued for batch ${batchId} (${mod})`);
    })
    .catch((err) => console.error('[WorkflowEmail] sendRevisionEmail error:', err.message));
}
