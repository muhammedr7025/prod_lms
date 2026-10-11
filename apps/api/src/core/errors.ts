import { HttpStatus } from '@nestjs/common';

/**
 * Domain errors carry a stable code and a human message that is shown as-is
 * in the UI ("blocking validations always state the reason").
 */
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = HttpStatus.UNPROCESSABLE_ENTITY,
    public readonly fields?: Record<string, string>,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, fields?: Record<string, string>) => new DomainError('BAD_REQUEST', message, 400, fields);
export const invalid = (message: string, fields?: Record<string, string>) => new DomainError('VALIDATION_FAILED', message, 422, fields);
export const notFound = (what = 'Record') => new DomainError('NOT_FOUND', `${what} not found`, 404);
export const forbidden = (message = 'You do not have access to this') => new DomainError('FORBIDDEN', message, 403);
export const conflict = (message: string, code = 'CONFLICT') => new DomainError(code, message, 409);
export const unauthenticated = (message = 'Please sign in', code = 'UNAUTHENTICATED') => new DomainError(code, message, 401);
