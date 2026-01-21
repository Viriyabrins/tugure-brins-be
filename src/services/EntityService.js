export default class EntityService {
  constructor({ entityRepository }) {
    this.entityRepository = entityRepository;
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
    return { id: record.id, ...record.payload };
  }

  async create(entity, payload) {
    const record = await this.entityRepository.create(entity, payload);
    return { id: record.id, ...record.payload };
  }

  async update(entity, id, payload) {
    const record = await this.entityRepository.update(entity, id, payload);
    if (!record) {
      const error = new Error(`Unable to update ${entity} ${id}`);
      error.statusCode = 404;
      throw error;
    }
    return { id: record.id, ...record.payload };
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
