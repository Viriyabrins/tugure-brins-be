export const sendSuccess = (reply, payload = null, message = 'Success') =>
  reply.code(200).send({ success: true, message, data: payload });

export const sendCreated = (reply, payload, message = 'Created') =>
  reply.code(201).send({ success: true, message, data: payload });

export const sendError = (reply, error, statusCode = 500) =>
  reply.code(statusCode).send({ success: false, message: error?.message || 'Unexpected error', details: error?.details ?? null });
