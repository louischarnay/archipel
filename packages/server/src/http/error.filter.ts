import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { DecisionError } from '../pipeline/pipeline.js';
import { validationIssues } from './errors.js';

// A body of our own (`{ error, reauth_required }`), as opposed to the one NestJS builds by default.
const isOwnBody = (body: unknown): body is { error: string } =>
  typeof body === 'object' && body !== null && 'error' in body && !('statusCode' in body);

// Every error leaves as `{ error }`, with the details a caller can act on and nothing else.
@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    if (reply.sent) return;

    if (error instanceof DecisionError) return reply.code(409).send({ error: error.message });
    if (error instanceof HttpException) {
      const body = error.getResponse();
      return reply.code(error.getStatus()).send(isOwnBody(body) ? body : { error: error.message });
    }
    const failure = error as FastifyError;
    if (failure.validation) return reply.code(400).send({ error: failure.message, issues: validationIssues(failure) });
    if (failure.statusCode && failure.statusCode < 500) return reply.code(failure.statusCode).send({ error: failure.message });
    http.getRequest<FastifyRequest>().log.error(error);
    return reply.code(500).send({ error: 'Internal error' });
  }
}
