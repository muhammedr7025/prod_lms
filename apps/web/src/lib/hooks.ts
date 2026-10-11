'use client';

import type { RouteDef } from '@exatech/contracts';
import { toast } from '@exatech/ui';
import { useMutation, useQuery, useQueryClient, type QueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { callApi, keyFor, type ApiArgs, type ApiError, type ApiResult } from './api';

export interface UseApiOptions<T> {
  enabled?: boolean;
  staleTime?: number;
  refetchInterval?: number | false;
  placeholderData?: UseQueryOptions<T, ApiError>['placeholderData'];
  select?: never;
}

/** Typed query for a contract route. */
export function useApi<D extends RouteDef>(def: D, args: ApiArgs<D>, opts: UseApiOptions<ApiResult<D>> = {}) {
  return useQuery<ApiResult<D>, ApiError>({
    queryKey: keyFor(def, args as Partial<ApiArgs<D>>),
    queryFn: ({ signal }) => callApi(def, args, { signal }),
    enabled: opts.enabled,
    staleTime: opts.staleTime,
    refetchInterval: opts.refetchInterval,
    placeholderData: opts.placeholderData,
  });
}

/** Invalidate every query under the given path prefixes, e.g. [['finance'], ['students']]. */
export function invalidatePrefixes(qc: QueryClient, prefixes: readonly (readonly string[])[]) {
  return Promise.all(prefixes.map((p) => qc.invalidateQueries({ queryKey: ['api', ...p] })));
}

export interface MutationOptions<D extends RouteDef> {
  /** Path prefixes to refetch after success (money & marks: invalidate, never optimistic). */
  invalidate?: readonly (readonly string[])[] | ((data: ApiResult<D>, args: ApiArgs<D>) => readonly (readonly string[])[]);
  /** Success toast text (false = none). */
  success?: string | ((data: ApiResult<D>, args: ApiArgs<D>) => string) | false;
  onSuccess?: (data: ApiResult<D>, args: ApiArgs<D>) => void;
  onError?: (error: ApiError, args: ApiArgs<D>) => void;
  /** Show the error as a toast (default true). Forms that show field errors inline can turn it off. */
  toastError?: boolean;
}

/** Typed mutation for a contract route with invalidation + toasts. */
export function useApiMutation<D extends RouteDef>(def: D, opts: MutationOptions<D> = {}) {
  const qc = useQueryClient();
  return useMutation<ApiResult<D>, ApiError, ApiArgs<D>>({
    mutationFn: (args) => callApi(def, args),
    onSuccess: async (data, args) => {
      const prefixes = typeof opts.invalidate === 'function' ? opts.invalidate(data, args) : opts.invalidate;
      if (prefixes?.length) await invalidatePrefixes(qc, prefixes);
      const msg = typeof opts.success === 'function' ? opts.success(data, args) : opts.success;
      if (msg) toast(msg);
      opts.onSuccess?.(data, args);
    },
    onError: (error, args) => {
      if (opts.toastError !== false) toast.error(error.message);
      opts.onError?.(error, args);
    },
  });
}
