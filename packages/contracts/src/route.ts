import { z } from 'zod';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * A route contract binds method, path, query, body and response to Zod
 * schemas. The API implements it with `@Endpoint(contract)`; the web calls it
 * with `api(contract, …)`. Changing a schema is a compile error on both sides.
 */
export interface RouteDef<
  M extends HttpMethod = HttpMethod,
  P extends string = string,
  Q extends z.ZodType | undefined = z.ZodType | undefined,
  B extends z.ZodType | undefined = z.ZodType | undefined,
  R extends z.ZodType = z.ZodType,
> {
  method: M;
  path: P;
  query?: Q;
  body?: B;
  response: R;
  summary?: string;
}

export function route<
  M extends HttpMethod,
  P extends string,
  R extends z.ZodType,
  Q extends z.ZodType | undefined = undefined,
  B extends z.ZodType | undefined = undefined,
>(def: { method: M; path: P; query?: Q; body?: B; response: R; summary?: string }): RouteDef<M, P, Q, B, R> {
  return def as RouteDef<M, P, Q, B, R>;
}

/** Extract ":param" names from a path. */
export type PathParams<P extends string> = P extends `${string}:${infer Param}/${infer Rest}`
  ? { [K in Param | keyof PathParams<`/${Rest}`>]: string }
  : P extends `${string}:${infer Param}`
    ? { [K in Param]: string }
    : Record<never, never>;

export type RouteQuery<D> = D extends RouteDef<HttpMethod, string, infer Q, z.ZodType | undefined, z.ZodType> ? (Q extends z.ZodType ? z.input<Q> : undefined) : never;
export type RouteBody<D> = D extends RouteDef<HttpMethod, string, z.ZodType | undefined, infer B, z.ZodType> ? (B extends z.ZodType ? z.input<B> : undefined) : never;
export type RouteResponse<D> = D extends RouteDef<HttpMethod, string, z.ZodType | undefined, z.ZodType | undefined, infer R> ? z.output<R> : never;
/** What a handler must return (before response parsing). */
export type HandlerResult<D> = D extends RouteDef<HttpMethod, string, z.ZodType | undefined, z.ZodType | undefined, infer R> ? z.input<R> : never;
export type ParsedQuery<D> = D extends RouteDef<HttpMethod, string, infer Q, z.ZodType | undefined, z.ZodType> ? (Q extends z.ZodType ? z.output<Q> : undefined) : never;
export type ParsedBody<D> = D extends RouteDef<HttpMethod, string, z.ZodType | undefined, infer B, z.ZodType> ? (B extends z.ZodType ? z.output<B> : undefined) : never;

export function buildPath(path: string, params: Record<string, string> = {}): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, (_m, k: string) => {
    const v = params[k];
    if (v == null) throw new Error(`Missing path param ${k} for ${path}`);
    return encodeURIComponent(v);
  });
}

/* ───────────────────────── Shared primitives ───────────────────────── */

export const zId = z.string().uuid();
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export const zTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
/** Instants travel as ISO strings; handlers may return Date objects. */
export const zInstant = z.union([z.date(), z.string()]).transform((v) => (v instanceof Date ? v.toISOString() : v));
export const zInstantNullable = zInstant.nullable();
/** Money in integer paise. */
export const zPaise = z.number().int();
export const zPaiseNonNeg = z.number().int().nonnegative();

export const zOk = z.object({ ok: z.literal(true) });
export const ok = { ok: true as const };

export const zPageQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function zPage<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable(), total: z.number().int().optional() });
}

/** Query-string booleans: "true"/"1" → true. */
export const zBoolQuery = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    /** Field-level validation messages: { "phone": "Enter a valid 10-digit mobile" } */
    fields?: Record<string, string>;
    details?: unknown;
  };
}
