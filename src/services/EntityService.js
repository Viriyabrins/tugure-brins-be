export default class EntityService {
  constructor({ entityRepository }) {
    this.entityRepository = entityRepository;
  }

  decodeJwtPayload(jwt) {
    if (!jwt || typeof jwt !== 'string') return null;
    const parts = jwt.split('.');
    if (parts.length < 2) return null;

    try {
      const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
      return JSON.parse(Buffer.from(normalized + padding, 'base64').toString('utf8'));
    } catch {
      return null;
    }
  }

  extractRolesFromPayload(tokenPayload) {
    if (!tokenPayload || typeof tokenPayload !== 'object') return [];

    const realmRoles = Array.isArray(tokenPayload.realm_access?.roles)
      ? tokenPayload.realm_access.roles
      : [];

    const resourceAccess = tokenPayload.resource_access && typeof tokenPayload.resource_access === 'object'
      ? tokenPayload.resource_access
      : {};

    const clientRoles = Object.values(resourceAccess)
      .flatMap((clientEntry) => (Array.isArray(clientEntry?.roles) ? clientEntry.roles : []));

    return [...realmRoles, ...clientRoles];
  }

  resolveAuditActor(context = {}) {
    const user = context?.user || {};
    const tokenPayload = this.decodeJwtPayload(user.token);

    const tokenRoles = this.extractRolesFromPayload(tokenPayload);
    const userRoles = Array.isArray(user.roles)
      ? user.roles
      : user.role
        ? [user.role]
        : [];

    const roleList = tokenRoles.length > 0 ? tokenRoles : userRoles;
    const normalizedRoles = roleList
      .map((role) => String(role).trim().toLowerCase())
      .filter(Boolean);

    const businessRoles = normalizedRoles.filter(
      (role) =>
        !role.startsWith('default-roles-') &&
        role !== 'offline_access' &&
        role !== 'uma_authorization'
    );

    const rolePriority = [
      'maker-brins-role',
      'checker-brins-role',
      'approver-tugure-role',
      'checker-tugure-role',
      'approver-brins-role'
    ];

    const prioritizedRole =
      rolePriority.find((role) => businessRoles.includes(role)) ||
      businessRoles[0] ||
      normalizedRoles[0] ||
      'USER';

    const userEmail =
      tokenPayload?.email ||
      tokenPayload?.preferred_username ||
      tokenPayload?.upn ||
      tokenPayload?.sub ||
      user?.email ||
      user?.id ||
      'unknown';

    return {
      user_email: userEmail,
      user_role: prioritizedRole,
    };
  }

  enforceAuditActor(payload = {}, context = {}) {
    const actor = this.resolveAuditActor(context);
    return {
      ...payload,
      user_email: actor.user_email,
      user_role: actor.user_role,
      ip_address: payload?.ip_address || context?.ipAddress || null,
    };
  }

  async list(entity, options) {
    return this.entityRepository.list(entity, options);
  }

  async get(entity, id) {
    const record = await this.entityRepository.get(entity, id);
    if (!record) {
      const error = new Error(`Record ${id} not found in ${entity}`);
      error.statusCode = 404;
      throw error;
    }
    // Support repository returning either { id, payload } or a flattened object with fields
    if (record.payload && typeof record.payload === 'object') {
      return { id: record.id, ...record.payload };
    }
    return record;
  }

  async create(entity, payload, context = {}) {
    const safePayload = entity === 'AuditLog'
      ? this.enforceAuditActor(payload, context)
      : payload;

    const record = await this.entityRepository.create(entity, safePayload);
    if (record && record.payload && typeof record.payload === 'object') {
      return { id: record.id, ...record.payload };
    }
    return record;
  }

  async update(entity, id, payload) {
    let previousDebtor = null;
    if (entity === 'Debtor') {
      previousDebtor = await this.entityRepository.get(entity, id);
    }

    const record = await this.entityRepository.update(entity, id, payload);
    if (!record) {
      const error = new Error(`Unable to update ${entity} ${id}`);
      error.statusCode = 404;
      throw error;
    }

    if (entity === 'Debtor') {
      const relatedBatchIds = new Set();
      if (previousDebtor?.batch_id) relatedBatchIds.add(previousDebtor.batch_id);
      if (record?.batch_id) relatedBatchIds.add(record.batch_id);

      for (const batchId of relatedBatchIds) {
        await this.entityRepository.reconcileBatchAfterDebtorUpdate(batchId, {
          approvedBy:
            payload?.approved_by ||
            payload?.reviewed_by ||
            payload?.validated_by ||
            null,
        });
      }
    }

    if (record.payload && typeof record.payload === 'object') {
      return { id: record.id, ...record.payload };
    }
    return record;
  }

  async delete(entity, id) {
    const record = await this.entityRepository.delete(entity, id);
    if (!record) {
      const error = new Error(`Unable to delete ${entity} ${id}`);
      error.statusCode = 404;
      throw error;
    }
    return { id: record.id };
  }
}
