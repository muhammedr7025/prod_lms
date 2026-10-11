import {
  applyDecorators,
  type ArgumentsHost,
  Catch,
  type CallHandler,
  createParamDecorator,
  type ExceptionFilter,
  type ExecutionContext,
  HttpException,
  Injectable,
  type NestInterceptor,
  Logger,
  RequestMapping,
  RequestMethod,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ApiErrorBody, ParsedBody, ParsedQuery, PathParams, RouteDef, HandlerResult } from '@exatech/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { map, type Observable } from 'rxjs';
import { ZodError, type z } from 'zod';
import { DomainError } from './errors';
import type { Permission } from '@exatech/contracts';

export const ROUTE_DEF = 'exa:route-def';
export const PERMS = 'exa:perms';
export const PUBLIC = 'exa:public';
export const ALLOW_READONLY = 'exa:allow-readonly';
export const ALLOW_2FA_PENDING = 'exa:allow-2fa-pending';

const METHOD: Record<string, RequestMethod> = {
  GET: RequestMethod.GET,
  POST: RequestMethod.POST,
  PUT: RequestMethod.PUT,
  PATCH: RequestMethod.PATCH,
  DELETE: RequestMethod.DELETE,
};

/**
 * Bind a controller method to a route contract. Controllers must use
 * `@Controller()` with no prefix — the contract path is absolute.
 */
export function Endpoint(def: RouteDef) {
  return applyDecorators(RequestMapping({ path: def.path, method: METHOD[def.method] }), SetMetadata(ROUTE_DEF, def));
}

/** Any one of the permissions grants access (checked by the global guard). */
export const Can = (...perms: Permission[]) => SetMetadata(PERMS, perms);
/** No session required (webhooks, public verification pages, health). */
export const Public = () => SetMetadata(PUBLIC, true);
/** Allowed during read-only impersonation even for non-GET methods. */
export const AllowReadOnly = () => SetMetadata(ALLOW_READONLY, true);
/** Allowed while 2FA enrolment/verification is pending. */
export const Allow2faPending = () => SetMetadata(ALLOW_2FA_PENDING, true);

export interface Args<D> {
  params: D extends RouteDef<infer _M, infer P> ? PathParams<P> : never;
  query: ParsedQuery<D>;
  body: ParsedBody<D>;
}

/** Parsed and validated { params, query, body } for the handler's contract. */
export const Input = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const req = context.switchToHttp().getRequest<FastifyRequest>();
  const def = Reflect.getMetadata(ROUTE_DEF, context.getHandler()) as RouteDef | undefined;
  if (!def) throw new Error('@Input() used on a handler without @Endpoint()');
  const params = (req.params ?? {}) as Record<string, string>;
  const query = def.query ? def.query.parse(req.query ?? {}) : undefined;
  const body = def.body ? def.body.parse(req.body ?? {}) : undefined;
  return { params, query, body };
});

/** Typed result helper so handlers get compile-time checks against the contract response. */
export type Result<D> = Promise<HandlerResult<D>> | HandlerResult<D>;

@Injectable()
export class ResponseContractInterceptor implements NestInterceptor {
  private readonly log = new Logger('Contract');
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const def = this.reflector.get<RouteDef | undefined>(ROUTE_DEF, context.getHandler());
    return next.handle().pipe(
      map((value) => {
        if (!def) return value;
        const parsed = (def.response as z.ZodType).safeParse(value);
        if (!parsed.success) {
          this.log.error(`Response for ${def.method} ${def.path} does not match its contract: ${JSON.stringify(parsed.error.issues.slice(0, 5))}`);
          throw new DomainError('RESPONSE_CONTRACT', 'The server produced an unexpected response', 500, undefined, process.env.NODE_ENV !== 'production' ? parsed.error.issues.slice(0, 5) : undefined);
        }
        return parsed.data;
      }),
    );
  }
}

/** Maps every error to { error: { code, message, fields? } }. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger('Error');

  catch(exception: unknown, host: ArgumentsHost) {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const req = host.switchToHttp().getRequest<FastifyRequest>();
    let status = 500;
    let body: ApiErrorBody = { error: { code: 'INTERNAL', message: 'Something went wrong. The error has been logged.' } };

    if (exception instanceof DomainError) {
      status = exception.status;
      body = { error: { code: exception.code, message: exception.message, fields: exception.fields, details: exception.details } };
    } else if (exception instanceof ZodError) {
      status = 400;
      const fields: Record<string, string> = {};
      for (const issue of exception.issues) {
        const key = issue.path.join('.') || '_';
        if (!fields[key]) fields[key] = issue.message;
      }
      const first = exception.issues[0];
      body = { error: { code: 'VALIDATION_FAILED', message: first ? `${first.path.join('.') || 'Input'}: ${first.message}` : 'Invalid input', fields } };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const r = exception.getResponse();
      const message = typeof r === 'string' ? r : ((r as { message?: string | string[] }).message ?? exception.message);
      body = { error: { code: status === 404 ? 'NOT_FOUND' : `HTTP_${status}`, message: Array.isArray(message) ? message.join(', ') : message } };
    } else if (pgErrorOf(exception)) {
      const pg = pgErrorOf(exception) as { code: string; detail?: string; constraint_name?: string; message: string };
      if (pg.code === '23505') {
        status = 409;
        body = { error: { code: 'DUPLICATE', message: 'A record with the same unique value already exists', details: pg.constraint_name } };
      } else if (pg.code === '23503') {
        status = 409;
        body = { error: { code: 'REFERENCED', message: 'This record is referenced by other records' } };
      } else if (pg.code === 'P0001') {
        status = 409;
        body = { error: { code: 'IMMUTABLE', message: pg.message } };
      } else {
        this.log.error(`${req.method} ${req.url} → ${pg.message}`);
        if (process.env.NODE_ENV !== 'production') body.error.details = pg.message;
      }
    } else {
      const err = exception as Error;
      this.log.error(`${req.method} ${req.url} → ${err?.stack ?? String(exception)}`);
      if (process.env.NODE_ENV !== 'production') body.error.details = err?.message;
    }
    void reply.status(status).send(body);
  }
}

/** Postgres error, possibly wrapped by drizzle's DrizzleQueryError (as `cause`). */
function pgErrorOf(e: unknown): unknown {
  const isPg = (x: unknown) => {
    const code = (x as { code?: unknown })?.code;
    return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && (x as { severity?: unknown }).severity !== undefined;
  };
  if (isPg(e)) return e;
  const cause = (e as { cause?: unknown })?.cause;
  return isPg(cause) ? cause : null;
}
