'use client';

import { portalContract, type NoteItem } from '@exatech/contracts';
import { Button, Card, cn, Corners, Icon, Kicker, Skeleton, Tag, toast } from '@exatech/ui';
import { useRef, useState } from 'react';
import { useMe } from '@/components/me-context';
import { ApiError, callApi } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { prefersReducedMotion } from '../lib';
import { LoadError, ScreenHeader, TypeIcon } from './parts';
import { usePaySheet } from './use-pay-sheet';

/** Student · Notes — by module; locked items wiggle then open the pay sheet; open items get a 5-minute signed (watermarked) link. */
export function NotesScreen() {
  const me = useMe();
  const { data, error, isPending, refetch } = useApi(portalContract.notes, { query: {} });
  const pay = usePaySheet();
  const [wiggle, setWiggle] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tapLocked = (n: NoteItem) => {
    if (timer.current) clearTimeout(timer.current);
    if (prefersReducedMotion()) return pay.open(data?.pay);
    setWiggle(n.id);
    timer.current = setTimeout(() => {
      setWiggle(null);
      pay.open(data?.pay);
    }, 250);
  };

  const openNote = async (n: NoteItem) => {
    if (me.readOnly) return toast.error('Read-only view — opening notes is disabled');
    // Open the tab synchronously (popup blockers), then point it at the signed link.
    const tab = window.open('', '_blank');
    setOpening(n.id);
    try {
      const r = await callApi(portalContract.openNote, { params: { id: n.id } });
      if (tab) tab.location.href = r.url;
      else window.location.assign(r.url);
      toast(r.watermarked ? `Opened “${n.title}” · watermarked with your name · link valid 5 min` : `Opened “${n.title}”`);
      void refetch();
    } catch (e) {
      tab?.close();
      toast.error(e instanceof ApiError ? e.message : 'Could not open this note');
      void refetch();
    } finally {
      setOpening(null);
    }
  };

  return (
    <>
      <ScreenHeader label="Student · Notes" kicker={data?.kicker} title="Notes" />
      {data?.lockedBanner && (
        <div className="relative bg-accent-100 px-3 py-2.5 text-[13px] flex justify-between items-center gap-2.5" data-testid="fee-gate-banner">
          <Corners />
          <span>{data.lockedBanner.text}</span>
          <Button variant="primary" size="lg" className="flex-none" onClick={() => pay.open(data.pay)}>
            {data.lockedBanner.payLabel}
          </Button>
        </div>
      )}
      {error && !data && <LoadError what="notes" error={error} onRetry={() => void refetch()} />}
      {isPending && !data && Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-[150px]" />)}
      {data && data.groups.length === 0 && (
        <Card pad="none">
          <div className="px-4 py-6 text-center text-[13px] text-neutral-600">No notes have been shared with your batch yet.</div>
        </Card>
      )}
      {data?.groups.map((g) => (
        <Card key={g.module} pad="none">
          <Kicker className="px-3 py-2.5 border-b border-divider">{g.module}</Kicker>
          {g.items.map((n) => (
            <button
              key={n.id}
              type="button"
              data-testid="note-row"
              data-status={n.status}
              onClick={() => (n.status === 'open' ? void openNote(n) : n.status === 'locked' ? tapLocked(n) : toast(`“${n.title}” · ${n.label.toLowerCase()}`))}
              className={cn(
                'flex items-center gap-2.5 px-3 py-2.5 border-0 border-b border-divider last:border-b-0 bg-transparent w-full min-h-[52px] font-[inherit] text-[inherit] cursor-pointer text-left hover:bg-accent-100 focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2',
                n.status === 'scheduled' && 'opacity-60',
              )}
            >
              <TypeIcon type={n.type} />
              <span className="flex-1 min-w-0">
                <span className="text-sm block">{n.title}</span>
                <span className="text-[11px] text-neutral-600 block">{n.meta}</span>
              </span>
              <Tag variant={n.tagVariant} className="flex-none gap-1">
                {n.status === 'locked' && <Icon name="lock" size={11} className={cn(wiggle === n.id && 'animate-wiggle')} />}
                {opening === n.id ? 'Opening…' : n.label}
              </Tag>
            </button>
          ))}
        </Card>
      ))}
      {data && <div className="text-xs text-neutral-600 text-center">Links are signed for 5 minutes · PDFs carry your name as a watermark</div>}
      {pay.element}
    </>
  );
}
