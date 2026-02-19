const DEFAULT_LIMIT = 20;
const MAX_LIMIT = parseInt(process.env.MAX_LIMIT, 10) || 100;

export function paginate(query = {}) {
    const rawPage = parseInt(query.page, 10);
    const rawLimit = parseInt(query.limit, 10);

    const page = rawPage && rawPage > 0 ? rawPage : 1;
    // limit=0 means "no limit" – return all records (used by frontend listAll / backward compat)
    const limit = rawLimit === 0
        ? 0
        : (rawLimit && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT);
    const offset = limit > 0 ? (page - 1) * limit : 0;

    return { page, limit, offset };
}

export function paginationResponse({ data, total, page, limit, offset }) {
    const totalPages = limit > 0 ? Math.ceil(total / limit) : 1;
    const returnedCount = Array.isArray(data) ? data.length : 0;

    return {
        data,
        pagination: {
            page,
            limit,
            total,
            totalPages,
            offset,
            returnedCount,
            hasNext: limit > 0 ? offset + returnedCount < total : false,
            hasPrev: offset > 0,
        },
    };
}