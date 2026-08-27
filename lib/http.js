// ════════════════════════════════════════════════════════════════════════════
// lib/http.js — the small, boring plumbing every route module shares
// ════════════════════════════════════════════════════════════════════════════

'use strict';

// Wrap an async handler so a rejected promise becomes a 500 (or the error's own
// status) instead of an unhandled rejection that kills the process.
function asyncH(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
    if (res.headersSent) return;
    const status = e && e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
    if (status >= 500) console.error(`[${req.method} ${req.originalUrl}]`, e);
    res.status(status).json({ error: e && e.message ? e.message : 'Server error', ...(e && e.extra ? e.extra : {}) });
  });
}

// Throwable HTTP errors — `throw badRequest('title required')` reads better
// than three lines of res.status().json().
function httpError(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  if (extra) e.extra = extra;
  return e;
}
const badRequest  = (m, x) => httpError(400, m, x);
const unauthorized = (m = 'Not authenticated') => httpError(401, m);
const forbidden   = (m = 'Not allowed') => httpError(403, m);
const notFound    = (m = 'Not found') => httpError(404, m);
const conflict    = (m, x) => httpError(409, m, x);
const unprocessable = (m, x) => httpError(422, m, x);

// GET-list paging that can never be abused into a full table scan.
function limitOf(req, def = 100, max = 500) {
  const n = parseInt(req.query.limit, 10);
  return Math.min(Number.isFinite(n) && n > 0 ? n : def, max);
}
function offsetOf(req) {
  const n = parseInt(req.query.offset, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function idParam(req, key = 'id') {
  const n = parseInt(req.params[key], 10);
  if (!Number.isFinite(n) || n <= 0) throw badRequest(`Invalid ${key}`);
  return n;
}
// Accumulates `WHERE a=$1 AND b=$2` without the off-by-one $n bookkeeping.
function whereBuilder() {
  const clauses = [];
  const params = [];
  return {
    add(sqlFn, value) {
      if (value === undefined || value === null || value === '') return;
      params.push(value);
      clauses.push(sqlFn(`$${params.length}`));
    },
    raw(sql) { clauses.push(sql); },
    sql() { return clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''; },
    params() { return params; },
    next() { return params.length + 1; }
  };
}

module.exports = {
  asyncH, httpError, badRequest, unauthorized, forbidden, notFound, conflict,
  unprocessable, limitOf, offsetOf, idParam, whereBuilder
};
