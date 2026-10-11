import 'server-only';
import type { RouteDef } from '@exatech/contracts';
import { dehydrate, HydrationBoundary } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { keyFor, type ApiArgs } from './api';
import { makeQueryClient } from './query-client';
import { serverApi } from './server';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PrefetchEntry = [RouteDef, any];

/** Typed tuple helper: q(contract.list, { query: {...} }) */
export function q<D extends RouteDef>(def: D, args: ApiArgs<D>): PrefetchEntry {
  return [def, args];
}

/**
 * Server-side prefetch + hydration: the page's primary queries render with
 * data on first paint and the client does not refetch them immediately.
 * Failed prefetches are skipped (the client query shows the error state).
 */
export async function Prefetch({ queries, children }: { queries: PrefetchEntry[]; children: ReactNode }) {
  const qc = makeQueryClient();
  await Promise.all(queries.map(([def, args]) => qc.prefetchQuery({ queryKey: keyFor(def, args), queryFn: () => serverApi(def, args) })));
  return <HydrationBoundary state={dehydrate(qc)}>{children}</HydrationBoundary>;
}
