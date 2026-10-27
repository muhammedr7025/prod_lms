import 'server-only';
import { coreContract, type Me, type RouteDef } from '@exatech/contracts';
import { cookies, headers } from 'next/headers';
import { cache } from 'react';
import { ApiError, callApi, type ApiArgs, type ApiResult } from './api';
import { unstable_rethrow } from 'next/navigation';

const API_URL = process.env.API_URL ?? 'http://localhost:4300';

/** Call the API from a Server Component, forwarding the user's cookies. */
export async function serverApi<D extends RouteDef>(def: D, args: ApiArgs<D>): Promise<ApiResult<D>> {
  const [c, h] = await Promise.all([cookies(), headers()]);
  const fwd: Record<string, string> = { cookie: c.toString() };
  const ip = h.get('x-forwarded-for');
  if (ip) fwd['x-forwarded-for'] = ip;
  return callApi(def, args, { baseUrl: API_URL, headers: fwd });
}

/** The signed-in user (deduplicated per request). Returns null when signed out. */
export const getMe = cache(async (): Promise<{ me: Me | null; error: ApiError | null }> => {
  try {
    const me = await serverApi(coreContract.me, {});
    return { me, error: null };
  } catch (err) {
    unstable_rethrow(err); // let Next's dynamic-rendering signals through (cookies() at build time)
    if (err instanceof ApiError) return { me: null, error: err };
    return { me: null, error: new ApiError(503, 'API_UNAVAILABLE', 'The API is not reachable') };
  }
});
