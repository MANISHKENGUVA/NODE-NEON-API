/**
 * Small helpers shared by every controller.
 */

/** Wraps an async route handler so rejections reach the error middleware. */
function handler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/** Standard success envelope. */
function success(res, data, statusCode = 200) {
  return res.status(statusCode).json({ success: true, status: "OK", data });
}

/** Success envelope without the `data` wrapper (flat responses). */
function ok(res, body, statusCode = 200) {
  return res.status(statusCode).json({ success: true, status: "OK", ...body });
}

module.exports = { handler, success, ok };
