'use client';

import { salesContract, type LeadCard } from '@exatech/contracts';
import { LEAD_STAGE_LABEL, nextStage, type LeadStage } from '@exatech/domain';
import { toast } from '@exatech/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { callApi, keyFor, type ApiError, type ApiResult } from '@/lib/api';
import { invalidatePrefixes } from '@/lib/hooks';

type Pipeline = ApiResult<typeof salesContract.pipeline>;
export interface StageMove {
  id: string;
  name: string;
  from: LeadStage;
  to: LeadStage;
  undo?: boolean;
}

/** Move a card between kanban columns in the cached pipeline (optimistic UI). */
function moveCard(data: Pipeline | undefined, m: StageMove): Pipeline | undefined {
  if (!data) return data;
  let card: LeadCard | undefined;
  const columns = data.columns.map((c) => {
    const found = c.leads.find((l) => l.id === m.id);
    if (!found) return c;
    card = found;
    return { ...c, count: c.count - 1, leads: c.leads.filter((l) => l.id !== m.id) };
  });
  if (!card) return data;
  const moved: LeadCard = { ...card, stage: m.to, stageLabel: LEAD_STAGE_LABEL[m.to], nextStage: nextStage(m.to) };
  return {
    ...data,
    openTotal: data.openTotal + (m.to === 'lost' ? -1 : 0) + (m.from === 'lost' ? 1 : 0),
    columns: columns.map((c) => (c.stage === m.to ? { ...c, count: c.count + 1, leads: [moved, ...c.leads] } : c)),
  };
}

/**
 * One-click / drag advance: optimistic move with a 6 s Undo toast that moves
 * the lead back (server re-validates every move).
 */
export function useStageMove() {
  const qc = useQueryClient();
  const key = keyFor(salesContract.pipeline, {});
  const m = useMutation<LeadCard, ApiError, StageMove, { prev?: Pipeline }>({
    mutationFn: (v) => callApi(salesContract.setStage, { params: { id: v.id }, body: { from: v.from, to: v.to, undo: !!v.undo } }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<Pipeline>(key);
      qc.setQueryData<Pipeline>(key, (d) => moveCard(d, v));
      return { prev };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      toast.error(err.message);
    },
    onSuccess: (card, v) => {
      if (v.undo) toast(`${v.name} moved back to ${LEAD_STAGE_LABEL[v.to]}`);
      else toast(`${v.name} → ${card.stageLabel}`, { undo: () => m.mutate({ id: v.id, name: v.name, from: v.to, to: v.from, undo: true }) });
    },
    onSettled: () => invalidatePrefixes(qc, [['sales']]),
  });
  return m;
}
