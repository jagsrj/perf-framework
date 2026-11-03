// Small Express helpers shared by the route modules.

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export const asyncHandler = (handler) => (request, response, next) => {
  Promise.resolve(handler(request, response, next)).catch(next);
};

export function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

export function respondError(response, error, status = error.statusCode || 500) {
  response.status(status).json({ error: error.message || String(error) });
}

export function validateScenarioIdParam(request, response, next, id) {
  if (!UUID.test(id)) return response.status(400).json({ error: 'Invalid scenario ID.' });
  next();
}
