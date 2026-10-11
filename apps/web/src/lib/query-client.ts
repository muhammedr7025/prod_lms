import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';

/**
 * Caching policy (PRD §15): lists 30 s, dashboards 60 s (set per query),
 * reference data long-lived; money and marks invalidate by key prefix.
 */
export function makeQueryClient(onError?: (err: unknown) => void) {
  return new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: true,
        retry: (count, err) => (err instanceof ApiError ? err.status >= 500 && count < 2 : count < 2),
      },
      mutations: { retry: false },
    },
  });
}
