import prisma from '../prisma/client.js';

export const WORKFLOW_TEMPLATE_SCOPE = 'WORKFLOW';
export const STATUS_TRANSITION_TEMPLATE_SCOPE = 'STATUS_TRANSITION';

export const WORKFLOW_ACTIONS = {
  UPLOAD: 'UPLOAD',
  CHECK_BRINS: 'CHECK_BRINS',
  APPROVE_BRINS: 'APPROVE_BRINS',
  CHECK_TUGURE: 'CHECK_TUGURE',
  APPROVE_FINAL: 'APPROVE_FINAL',
  REVISION: 'REVISION',
};

export const WORKFLOW_AUDIENCES = {
  ACTOR_SELF: 'ACTOR_SELF',
  UPLOADER: 'UPLOADER',
  BRINS_CHECKERS: 'BRINS_CHECKERS',
  BRINS_APPROVERS: 'BRINS_APPROVERS',
  TUGURE_CHECKERS: 'TUGURE_CHECKERS',
  TUGURE_APPROVERS: 'TUGURE_APPROVERS',
  PRIOR_ACTORS: 'PRIOR_ACTORS',
};

const ACTION_STATUS_MAP = {
  [WORKFLOW_ACTIONS.UPLOAD]: 'SUBMITTED',
  [WORKFLOW_ACTIONS.CHECK_BRINS]: 'CHECKED_BRINS',
  [WORKFLOW_ACTIONS.APPROVE_BRINS]: 'APPROVED_BRINS',
  [WORKFLOW_ACTIONS.CHECK_TUGURE]: 'CHECKED_TUGURE',
  [WORKFLOW_ACTIONS.APPROVE_FINAL]: 'APPROVED',
  [WORKFLOW_ACTIONS.REVISION]: 'REVISION',
};

export function moduleToObjectType(mod) {
  switch ((mod || '').toUpperCase()) {
    case 'MC':
    case 'MASTER_CONTRACT':
      return 'MasterContract';
    case 'CLAIM':
      return 'Claim';
    case 'SUBROGATION':
      return 'Subrogation';
    default:
      return 'Debtor';
  }
}

export function moduleLabel(mod) {
  switch ((mod || '').toUpperCase()) {
    case 'MC':
    case 'MASTER_CONTRACT':
      return 'Master Contract';
    case 'CLAIM':
      return 'Claim';
    case 'SUBROGATION':
      return 'Subrogation';
    default:
      return 'Debtor Batch';
  }
}

export function workflowStatusForAction(action) {
  return ACTION_STATUS_MAP[action] || action;
}

export function replaceTemplateVariables(template, variables = {}) {
  if (!template) return '';

  return Object.entries(variables).reduce((result, [key, value]) => {
    const safeKey = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\{${safeKey}\\}`, 'g');
    return result.replace(regex, value == null ? '' : String(value));
  }, String(template));
}

export async function getWorkflowTemplate({ objectType, workflowAction, workflowAudience }) {
  return prisma.emailTemplate.findFirst({
    where: {
      object_type: objectType,
      template_scope: WORKFLOW_TEMPLATE_SCOPE,
      workflow_action: workflowAction,
      workflow_audience: workflowAudience,
      is_active: true,
    },
    orderBy: { id: 'asc' },
  });
}

const templateRow = ({
  objectType,
  workflowAction,
  workflowAudience,
  recipientRole,
  emailSubject,
  emailBody,
}) => ({
  object_type: objectType,
  status_from: null,
  status_to: workflowStatusForAction(workflowAction),
  recipient_role: recipientRole,
  template_scope: WORKFLOW_TEMPLATE_SCOPE,
  workflow_action: workflowAction,
  workflow_audience: workflowAudience,
  email_subject: emailSubject,
  email_body: emailBody,
  is_active: true,
});

function buildSeedTemplatesForObjectType(objectType) {
  const label = objectType === 'MasterContract'
    ? 'Master Contract'
    : objectType === 'Claim'
      ? 'Claim'
      : objectType === 'Subrogation'
        ? 'Subrogation'
        : 'Debtor Batch';
  const labelLower = label.toLowerCase();
  const isDebtorOrClaim = objectType === 'Debtor' || objectType === 'Claim';
  const isMasterContract = objectType === 'MasterContract';

  return [
    templateRow({
      objectType,
      workflowAction: WORKFLOW_ACTIONS.UPLOAD,
      workflowAudience: WORKFLOW_AUDIENCES.UPLOADER,
      recipientRole: 'BRINS',
      emailSubject: `You Have Successfully Uploaded ${label}`,
      emailBody: `<p>Your ${labelLower} upload for batch <strong>{batch_id}</strong>{record_count_text} has been submitted successfully and is awaiting BRINS Checker review.</p>`,
    }),
    templateRow({
      objectType,
      workflowAction: WORKFLOW_ACTIONS.UPLOAD,
      workflowAudience: WORKFLOW_AUDIENCES.BRINS_CHECKERS,
      recipientRole: 'BRINS',
      emailSubject: `New ${label} Uploaded - Action Required`,
      emailBody: `<p>A new ${labelLower} batch <strong>{batch_id}</strong>{record_count_text} has been uploaded by {uploader_display} and is awaiting your review.</p>`,
    }),
    templateRow({
      objectType,
      workflowAction: WORKFLOW_ACTIONS.CHECK_BRINS,
      workflowAudience: WORKFLOW_AUDIENCES.ACTOR_SELF,
      recipientRole: 'BRINS',
      emailSubject: `You Have Successfully Checked ${label}`,
      emailBody: `<p>You have successfully reviewed ${labelLower} batch <strong>{batch_id}</strong>. It is now awaiting BRINS Approver sign-off.</p>`,
    }),
    templateRow({
      objectType,
      workflowAction: WORKFLOW_ACTIONS.CHECK_BRINS,
      workflowAudience: WORKFLOW_AUDIENCES.UPLOADER,
      recipientRole: 'BRINS',
      emailSubject: `Your ${label} Has Been Checked by BRINS`,
      emailBody: `<p>{actor_display} has reviewed ${labelLower} batch <strong>{batch_id}</strong>. It is now pending BRINS approval.</p>`,
    }),
    templateRow({
      objectType,
      workflowAction: WORKFLOW_ACTIONS.CHECK_BRINS,
      workflowAudience: WORKFLOW_AUDIENCES.BRINS_APPROVERS,
      recipientRole: 'BRINS',
      emailSubject: `${label} Ready for BRINS Approval - Batch {batch_id}`,
      emailBody: `<p>${label} batch <strong>{batch_id}</strong> has been checked by {actor_display_lower} and is awaiting your approval.</p>`,
    }),
    templateRow({
      objectType,
      workflowAction: WORKFLOW_ACTIONS.APPROVE_BRINS,
      workflowAudience: WORKFLOW_AUDIENCES.ACTOR_SELF,
      recipientRole: 'BRINS',
      emailSubject: `You Have Successfully Approved ${label}`,
      emailBody: `<p>You have approved ${labelLower} batch <strong>{batch_id}</strong>. It has been forwarded to TUGURE Checker for review.</p>`,
    }),
    templateRow({
      objectType,
      workflowAction: WORKFLOW_ACTIONS.APPROVE_BRINS,
      workflowAudience: WORKFLOW_AUDIENCES.UPLOADER,
      recipientRole: 'BRINS',
      emailSubject: `Your ${label} Has Been Approved by BRINS - Batch {batch_id}`,
      emailBody: isDebtorOrClaim
        ? `<p>A nota premi has been generated for batch <strong>{batch_id}</strong>. It is now pending TUGURE review.</p>`
        : `<p>${label} batch <strong>{batch_id}</strong> has been approved by BRINS and is now pending TUGURE review.</p>`,
    }),
    templateRow({
      objectType,
      workflowAction: WORKFLOW_ACTIONS.APPROVE_BRINS,
      workflowAudience: WORKFLOW_AUDIENCES.PRIOR_ACTORS,
      recipientRole: 'BRINS',
      emailSubject: `${label} Approved by BRINS - Batch {batch_id}`,
      emailBody: `<p>{actor_display} has approved ${labelLower} batch <strong>{batch_id}</strong>. It is now pending TUGURE review.</p>`,
    }),
    templateRow({
      objectType,
      workflowAction: WORKFLOW_ACTIONS.APPROVE_BRINS,
      workflowAudience: WORKFLOW_AUDIENCES.TUGURE_CHECKERS,
      recipientRole: 'TUGURE',
      emailSubject: `${label} Ready for TUGURE Review - Batch {batch_id}`,
      emailBody: `<p>${label} batch <strong>{batch_id}</strong> has been approved by BRINS and is awaiting your review.</p>`,
    }),
    templateRow({
      objectType,
      workflowAction: WORKFLOW_ACTIONS.CHECK_TUGURE,
      workflowAudience: WORKFLOW_AUDIENCES.ACTOR_SELF,
      recipientRole: 'TUGURE',
      emailSubject: `You Have Successfully Checked ${label} at TUGURE`,
      emailBody: `<p>You have reviewed ${labelLower} batch <strong>{batch_id}</strong>. It is now pending TUGURE final approval.</p>`,
    }),
    templateRow({
      objectType,
      workflowAction: WORKFLOW_ACTIONS.CHECK_TUGURE,
      workflowAudience: WORKFLOW_AUDIENCES.PRIOR_ACTORS,
      recipientRole: 'BRINS',
      emailSubject: `${label} Checked by TUGURE - Batch {batch_id}`,
      emailBody: `<p>{actor_display} has reviewed ${labelLower} batch <strong>{batch_id}</strong>. It is now pending TUGURE final approval.</p>`,
    }),
    templateRow({
      objectType,
      workflowAction: WORKFLOW_ACTIONS.CHECK_TUGURE,
      workflowAudience: WORKFLOW_AUDIENCES.TUGURE_APPROVERS,
      recipientRole: 'TUGURE',
      emailSubject: `${label} Ready for TUGURE Final Approval - Batch {batch_id}`,
      emailBody: `<p>${label} batch <strong>{batch_id}</strong> has been checked by {actor_display_lower} and is awaiting your final approval.</p>`,
    }),
    templateRow({
      objectType,
      workflowAction: WORKFLOW_ACTIONS.APPROVE_FINAL,
      workflowAudience: WORKFLOW_AUDIENCES.ACTOR_SELF,
      recipientRole: 'TUGURE',
      emailSubject: `You Have Given Final Approval for ${label} - Batch {batch_id}`,
      emailBody: `<p>You have given final approval for ${labelLower} batch <strong>{batch_id}</strong>.</p>`,
    }),
    templateRow({
      objectType,
      workflowAction: WORKFLOW_ACTIONS.APPROVE_FINAL,
      workflowAudience: WORKFLOW_AUDIENCES.UPLOADER,
      recipientRole: 'BRINS',
      emailSubject: isMasterContract
        ? `Master Contract Approved - Ready for Debtor Upload (Batch {batch_id})`
        : `${label} Finally Approved - Batch {batch_id}`,
      emailBody: isMasterContract
        ? `<p>Your master contract (batch <strong>{batch_id}</strong>) has received final TUGURE approval. The contract is now active and ready to be used for debtor list uploads.</p>`
        : `<p>${label} batch <strong>{batch_id}</strong> has received final TUGURE approval from {actor_display_lower}.</p>`,
    }),
    templateRow({
      objectType,
      workflowAction: WORKFLOW_ACTIONS.APPROVE_FINAL,
      workflowAudience: WORKFLOW_AUDIENCES.PRIOR_ACTORS,
      recipientRole: 'ALL',
      emailSubject: `${label} Finally Approved - Batch {batch_id}`,
      emailBody: `<p>${label} batch <strong>{batch_id}</strong> has received final TUGURE approval from {actor_display_lower}.</p>`,
    }),
    templateRow({
      objectType,
      workflowAction: WORKFLOW_ACTIONS.REVISION,
      workflowAudience: WORKFLOW_AUDIENCES.UPLOADER,
      recipientRole: 'BRINS',
      emailSubject: `${label} Sent for Revision - Batch {batch_id}`,
      emailBody: `<p>Your ${labelLower} batch <strong>{batch_id}</strong> has been sent for revision. Please review the remarks and re-submit.</p>{remarks_block}`,
    }),
  ];
}

export function getWorkflowTemplateSeeds() {
  return [
    ...buildSeedTemplatesForObjectType('MasterContract'),
    ...buildSeedTemplatesForObjectType('Debtor'),
    ...buildSeedTemplatesForObjectType('Claim'),
    ...buildSeedTemplatesForObjectType('Subrogation'),
  ];
}

export async function seedWorkflowEmailTemplates(logger = console) {
  const seeds = getWorkflowTemplateSeeds();

  for (const seed of seeds) {
    const existing = await prisma.emailTemplate.findFirst({
      where: {
        object_type: seed.object_type,
        template_scope: seed.template_scope,
        workflow_action: seed.workflow_action,
        workflow_audience: seed.workflow_audience,
        recipient_role: seed.recipient_role,
      },
      select: { id: true },
    });

    if (!existing) {
      await prisma.emailTemplate.create({ data: seed });
    }
  }

  logger.info?.(`[WorkflowEmailTemplateService] Seeded workflow email templates (${seeds.length} definitions checked).`);
}
