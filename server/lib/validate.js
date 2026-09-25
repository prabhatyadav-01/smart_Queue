'use strict';

const { z } = require('zod');
const { errors } = require('../errors');

/** Parse `data` with a zod schema or throw a 400 with a readable message. */
function parse(schema, data) {
  const result = schema.safeParse(data ?? {});
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue.path.length ? `${issue.path.join('.')}: ` : '';
  throw errors.badRequest(`${field}${issue.message}`);
}

const id = z.coerce.number().int().positive();

/** Success envelope used by every JSON endpoint. */
const ok = (data) => ({ success: true, data, error: null });

module.exports = { z, parse, id, ok };
