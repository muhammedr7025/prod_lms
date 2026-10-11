import { buildPath, type PathParams, type RouteBody, type RouteDef, type RouteQuery, type RouteResponse } from '@exatech/contracts';

/** Error thrown for any non-2xx API response; `message` is safe to show to users. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fields?: Record<string, string>,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

type ParamsArg<D> = D extends RouteDef<infer _M, infer P> ? (keyof PathParams<P> extends never ? { params?: undefined } : { params: PathParams<P> }) : never;
type QueryArg<D> = RouteQuery<D> extends undefined ? { query?: undefined } : { query?: RouteQuery<D> };
type BodyArg<D> = RouteBody<D> extends undefined ? { body?: undefined } : { body: RouteBody<D> };

/** Arguments for calling a route contract: { params, query, body } as the contract requires. */
export type ApiArgs<D> = ParamsArg<D> & QueryArg<D> & BodyArg<D>;
export type ApiResult<D> = RouteResponse<D>;

function toQueryString(query: Record<string, unknown> | undefined): string {
  if (!query) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, String(x)));
    else sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/**
 * Query key for a contract call: ['api', ...path segments, query]. Prefix
 * invalidation works on path segments, e.g. ['api','finance'] invalidates
 * every finance query.
 */
export function keyFor<D extends RouteDef>(def: D, args?: Partial<ApiArgs<D>>): unknown[] {
  const a = (args ?? {}) as { params?: Record<string, string>; query?: Record<string, unknown> };
  const path = buildPath(def.path, a.params ?? {});
  const segs = path.replace(/^\/api\//, '').split('/').filter(Boolean);
  return a.query && Object.keys(a.query).length ? ['api', ...segs, a.query] : ['api', ...segs];
}

export interface CallOptions {
  baseUrl?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export async function callApi<D extends RouteDef>(def: D, args: ApiArgs<D>, opts: CallOptions = {}): Promise<ApiResult<D>> {
  const a = args as { params?: Record<string, string>; query?: Record<string, unknown>; body?: unknown };
  const url = `${opts.baseUrl ?? ''}${buildPath(def.path, a.params ?? {})}${toQueryString(a.query)}`;
  const hasBody = def.method !== 'GET' && def.method !== 'DELETE';
  const res = await fetch(url, {
    method: def.method,
    headers: { ...(hasBody ? { 'Content-Type': 'application/json' } : {}), Accept: 'application/json', ...opts.headers },
    body: hasBody ? JSON.stringify(a.body ?? {}) : undefined,
    credentials: 'same-origin',
    cache: 'no-store',
    signal: opts.signal,
  });
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as ApiResult<D>;
  return (await res.json()) as ApiResult<D>;
}

export async function toApiError(res: Response): Promise<ApiError> {
  let body: { error?: { code?: string; message?: string; fields?: Record<string, string>; details?: unknown }; message?: string; code?: string } = {};
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  const e = body.error;
  const message = e?.message ?? body.message ?? (res.status === 403 ? 'You do not have access to this' : res.status >= 500 ? 'Something went wrong. Please try again.' : 'Request failed');
  return new ApiError(res.status, e?.code ?? body.code ?? `HTTP_${res.status}`, message, e?.fields, e?.details);
}

/** Better Auth endpoints are not contract routes; this posts JSON and surfaces their errors. */
export async function authPost<T = unknown>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
  if (!res.ok) throw await toApiError(res);
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

/** Upload a file (multipart) for a purpose; returns the stored file reference. */
export async function uploadFile(file: File, purpose: string): Promise<{ id: string; filename: string; mime: string; size: number }> {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(`/api/files?purpose=${encodeURIComponent(purpose)}`, { method: 'POST', body: fd, credentials: 'same-origin' });
  if (!res.ok) throw await toApiError(res);
  return res.json();
}

export const AUTH_ERROR_CODES = new Set(['UNAUTHENTICATED', 'SESSION_IDLE', 'SESSION_EXPIRED']);
