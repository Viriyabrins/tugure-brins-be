import { sendSuccess, sendCreated, sendError } from '../utils/response.js';

export default class EntityController {
  constructor({ entityService }) {
    this.entityService = entityService;
  }

  async list(request, reply) {
    try {
      const params = {
        sort: request.query.sort,
        limit: Number(request.query.limit) || 50
      };
      const items = await this.entityService.list(request.params.entityName, params);
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
      const entity = await this.entityService.create(request.params.entityName, request.body);
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
}
