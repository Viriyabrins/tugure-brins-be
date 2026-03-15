import { sendSuccess, sendCreated, sendError } from '../utils/response.js';
import { paginate, paginationResponse } from '../utils/pagination.js';

export default class EntityController {
  constructor({ entityService }) {
    this.entityService = entityService;
  }

  async list(request, reply) {
    try {
      const { page, limit, offset } = paginate(request.query);
      // support optional JSON filter in `q` query param (frontend may send q=JSON.stringify(filters))
      let parsedFilters = undefined;
      if (request.query && request.query.q) {
        try {
          parsedFilters = JSON.parse(request.query.q);
        } catch (e) {
          // ignore parse errors and treat as no filters
          parsedFilters = undefined;
        }
      }

      const params = { sort: request.query.sort, limit, offset, page, filters: parsedFilters };
      const items = await this.entityService.list(request.params.entityName, params);

      // If repository returned pagination metadata, wrap with paginationResponse
      if (items && Object.prototype.hasOwnProperty.call(items, 'data') && typeof items.total === 'number') {
        const resp = paginationResponse({ data: items.data, total: items.total, page, limit, offset });
        return sendSuccess(reply, resp, 'Entities loaded');
      }

      return sendSuccess(reply, items, 'Entities loaded');
    } catch (error) {
      return sendError(reply, error, error.statusCode || 500);
    }
  }

  async get(request, reply) {
    try {
      const entity = await this.entityService.get(request.params.entityName, request.params.id);
      return sendSuccess(reply, entity, 'Entity fetched');
    } catch (error) {
      return sendError(reply, error, error.statusCode || 404);
    }
  }

  async create(request, reply) {
    try {
      const entity = await this.entityService.create(
        request.params.entityName,
        request.body,
        {
          user: request.user,
          ipAddress: request.ip,
          headers: request.headers,
        }
      );
      return sendCreated(reply, entity, 'Entity created');
    } catch (error) {
      return sendError(reply, error, error.statusCode || 500);
    }
  }

  async update(request, reply) {
    try {
      const entity = await this.entityService.update(
        request.params.entityName,
        request.params.id,
        request.body
      );
      return sendSuccess(reply, entity, 'Entity updated');
    } catch (error) {
      return sendError(reply, error, error.statusCode || 404);
    }
  }

  async delete(request, reply) {
    try {
      const entity = await this.entityService.delete(request.params.entityName, request.params.id);
      return sendSuccess(reply, entity, 'Entity removed');
    } catch (error) {
      return sendError(reply, error, error.statusCode || 404);
    }
  }

  async uploadMasterContracts(request, reply) {
    try {
      const isReviseMode = String(request.body?.uploadMode || '').toLowerCase() === 'revise';
      const result = await this.entityService.uploadMasterContractsAtomic(
        request.body,
        {
          user: request.user,
          ipAddress: request.ip,
          headers: request.headers,
        }
      );
      return sendCreated(
        reply,
        result,
        isReviseMode
          ? 'Revisi master contract berhasil diproses'
          : 'Master contracts uploaded successfully'
      );
    } catch (error) {
      return sendError(reply, error, error.statusCode || 500);
    }
  }

  async uploadDebtors(request, reply) {
    try {
      const isReviseMode = String(request.body?.uploadMode || '').toLowerCase() === 'revise';
      const result = await this.entityService.uploadDebtorsAtomic(
        request.body,
        {
          user: request.user,
          ipAddress: request.ip,
          headers: request.headers,
        }
      );
      return sendCreated(
        reply,
        result,
        isReviseMode
          ? 'Revisi debtor berhasil diproses'
          : 'Debtors uploaded successfully'
      );
    } catch (error) {
      return sendError(reply, error, error.statusCode || 500);
    }
  }

  async processMasterContractApproval(request, reply) {
    try {
      const result = await this.entityService.processMasterContractApprovalAtomic(
        request.params.contractId,
        request.body,
        {
          user: request.user,
          ipAddress: request.ip,
          headers: request.headers,
        }
      );
      return sendSuccess(reply, result, 'Master contract approval processed successfully');
    } catch (error) {
      return sendError(reply, error, error.statusCode || 500);
    }
  }
}
