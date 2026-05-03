import prisma from '../prisma/client.js';
import { getUsersByRole } from '../utils/keycloakUtils.js';
import {
  getWorkflowTemplate,
  moduleLabel,
  moduleToObjectType,
  replaceTemplateVariables,
} from './WorkflowEmailTemplateService.js';

const BRINS_ROLES = new Set(['maker-brins-role', 'checker-brins-role', 'approver-brins-role', 'admin-brins-role']);
const TUGURE_ROLES = new Set(['checker-tugure-role', 'approver-tugure-role', 'tugure-checker-role', 'tugure-approver-role']);
const ALL_WORKFLOW_ROLES = [
  'maker-brins-role',
  'checker-brins-role',
  'approver-brins-role',
  'checker-tugure-role',
  'approver-tugure-role',
];

function normalizeRole(role) {
  return String(role || '').trim().toLowerCase();
}

function rolesFromTargetRole(targetRole) {
  const normalized = normalizeRole(targetRole);
  if (!normalized) return [];
  if (normalized === 'all') return [...ALL_WORKFLOW_ROLES];
  if (normalized === 'brins') return ['maker-brins-role', 'checker-brins-role', 'approver-brins-role'];
  if (normalized === 'tugure') return ['checker-tugure-role', 'approver-tugure-role'];
  if (normalized === 'admin') return ['admin-brins-role'];
  return [normalized];
}

function realmForRole(role) {
  const normalized = normalizeRole(role);
  if (BRINS_ROLES.has(normalized)) return 'brins';
  if (TUGURE_ROLES.has(normalized)) return 'tugure';
  return null;
}

export async function resolveTargetUsersFromRoles(targetRoles = []) {
  const roles = [...new Set(targetRoles.map(normalizeRole).filter(Boolean))];
  const resolvedUsers = [];

  for (const role of roles) {
    const realm = realmForRole(role);
    if (!realm) continue;
    const users = await getUsersByRole(realm, role);
    for (const user of users || []) {
      if (user?.id) {
        resolvedUsers.push({ id: user.id, role });
      }
    }
  }

  const byUserId = new Map();
  for (const user of resolvedUsers) {
    if (!byUserId.has(user.id)) byUserId.set(user.id, []);
    byUserId.get(user.id).push(user.role);
  }

  return [...byUserId.entries()].map(([id, rolesForUser]) => ({
    id,
    roles: [...new Set(rolesForUser)],
  }));
}

/**
 * Check if a user has enabled a specific notification type for a given channel
 * @param {Object} userSettings - User's NotificationSetting record
 * @param {string} notificationType - The notification type key (e.g., 'batch_status', 'claim_status')
 * @param {string} channel - 'email' or 'inapp' (default: 'inapp')
 * @returns {boolean} True if the user has enabled this notification for the channel
 */
function shouldSendNotification(userSettings, notificationType, channel = 'inapp') {
  if (!userSettings) return true; // If no settings found, default to sending
  
  const fieldKey = channel === 'email' 
    ? `email_notify_${notificationType}`
    : `inapp_notify_${notificationType}`;
  
  // Default to true if field doesn't exist (backward compatibility)
  return userSettings[fieldKey] !== false;
}

export async function createNotificationFanout(payload = {}, options = {}) {
  const {
    title,
    message,
    type = 'INFO',
    module = 'platform',
    reference_id = null,
    reference_type = null,
    action_url = null,
    target_user,
    target_role,
    notificationType = null, // New parameter: e.g., 'batch_status', 'claim_status'
  } = payload;

  if (!title || !message) return [];

  const explicitTargetUsers = Array.isArray(options.targetUsers) ? options.targetUsers.filter(Boolean) : [];
  let targetUsers = explicitTargetUsers;

  if (targetUsers.length === 0) {
    if (target_user) {
      targetUsers = [String(target_user)];
    } else if (target_role) {
      const roles = rolesFromTargetRole(target_role);
      const resolved = await resolveTargetUsersFromRoles(roles);
      targetUsers = resolved.map((u) => u.id);
    }
  }

  if (targetUsers.length === 0) return [];

  // If notificationType is specified, check user preferences before creating notifications
  const rows = [];
  
  if (notificationType) {
    // Fetch all user settings to check preferences
    for (const userId of targetUsers) {
      try {
        const userSettings = await prisma.notificationSetting.findUnique({
          where: { keycloak_user_id: userId },
        });
        
        // Check if user has enabled in-app notifications for this type
        if (shouldSendNotification(userSettings, notificationType, 'inapp')) {
          rows.push({
            title,
            message,
            type,
            module,
            reference_id,
            reference_type,
            action_url,
            target_user: userId,
            target_role: target_role || null,
          });
        }
      } catch (err) {
        // If there's an error fetching preferences, default to sending the notification
        console.warn(`[NotificationDispatch] Error fetching preferences for user ${userId}:`, err.message);
        rows.push({
          title,
          message,
          type,
          module,
          reference_id,
          reference_type,
          action_url,
          target_user: userId,
          target_role: target_role || null,
        });
      }
    }
  } else {
    // No notification type specified, create for all users (backward compatibility)
    rows.push(...targetUsers.map((userId) => ({
      title,
      message,
      type,
      module,
      reference_id,
      reference_type,
      action_url,
      target_user: userId,
      target_role: target_role || null,
    })));
  }

  return Promise.all(
    rows.map((row) =>
      prisma.notification.create({
        data: row,
      })
    )
  );
}

function buildVariables(ctx = {}, defaults = {}) {
  const module_label = moduleLabel(ctx.module);
  const normalizedRemarks = String(ctx.remarks || '').trim();
  const recordCount = Number(ctx.count) > 0 ? String(Number(ctx.count)) : '';

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

function htmlToText(value = '') {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+\n/g, '\n')
    .trim();
}

export async function createWorkflowAudienceNotifications({
  workflowAction,
  workflowAudience,
  ctx = {},
  fallbackSubject,
  fallbackBody,
  defaults = {},
  targetUsers = [],
  targetRole = null,
  type = 'INFO',
  module = 'SYSTEM',
  referenceId = null,
  referenceType = null,
  notificationType = null, // New parameter for preference checking
} = {}) {
  const userIds = [...new Set((Array.isArray(targetUsers) ? targetUsers : [targetUsers]).filter(Boolean))];
  if (!workflowAction || !workflowAudience || userIds.length === 0) return [];

  const objectType = moduleToObjectType(ctx.module || module);
  const variables = buildVariables(ctx, defaults);

  let subject = fallbackSubject || '';
  let body = fallbackBody || '';
  try {
    const template = await getWorkflowTemplate({ objectType, workflowAction, workflowAudience });
    if (template) {
      subject = template.email_subject || subject;
      body = template.email_body || body;
    }
  } catch (err) {
    console.warn(`[NotificationDispatch] Workflow template lookup failed: ${err.message}`);
  }

  const renderedTitle = replaceTemplateVariables(subject, variables);
  const renderedMessage = htmlToText(replaceTemplateVariables(body, variables));
  if (!renderedTitle || !renderedMessage) return [];

  return createNotificationFanout(
    {
      title: renderedTitle,
      message: renderedMessage,
      type,
      module,
      reference_id: referenceId || ctx.batchId || null,
      reference_type: referenceType || moduleToObjectType(ctx.module || module),
      target_role: targetRole,
      notificationType, // Pass it through
    },
    { targetUsers: userIds }
  );
}
