import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyRequest } from 'fastify';

const storage = new AsyncLocalStorage<FastifyRequest>();

export const withRequest = (request: FastifyRequest, next: () => void) => storage.run(request, next);

// The audit takes the author from the verified identity, not from a name passed by the caller: a display name can be spoofed.
export function auditOrigin() {
  const request = storage.getStore();
  if (!request) return { actor_type: 'system', actor_id: null, ip: null, request_id: null };
  const actor: [string, string | null] = request.agent
    ? ['agent', request.agent.id]
    : request.user
      ? ['user', request.user.sub]
      : ['anonymous', null];
  return { actor_type: actor[0], actor_id: actor[1], ip: request.ip, request_id: request.id };
}
