import { explainAjvErrors } from '@archipel/manifest-schema';
import type { FastifyError } from 'fastify';
import type { ErrorObject } from 'ajv';

// An error response can end up in a log: these values are never copied into it.
const SECRET_FIELD = /secret|password|code|url/i;

// Same format as manifest errors: path, received value, expected value, fix.
export function validationIssues(error: FastifyError) {
  const context = error.validationContext ?? 'body';
  return explainAjvErrors(error.validation as ErrorObject[]).map(({ received, ...item }) => {
    const path = item.path === '(root)' ? context : `${context}.${item.path}`;
    return { ...item, path, ...(SECRET_FIELD.test(path) ? {} : { received }) };
  });
}
