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
    // Support repository returning either { id, payload } or a flattened object with fields
    if (record.payload && typeof record.payload === 'object') {
      return { id: record.id, ...record.payload };
    }
    return record;
  }

  async create(entity, payload) {
    const record = await this.entityRepository.create(entity, payload);
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
