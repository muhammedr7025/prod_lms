'use client';

import { Button, Icon, Kicker, Sheet, Skeleton, Tag } from '@exatech/ui';
import type { ReactNode } from 'react';
import { useDrawer } from './drawer-context';
import { DRAWERS } from './registry';

/** Renders whichever detail panel is open (student, teacher, branch, exam). */
export function DrawerHost() {
  const { current, close } = useDrawer();
  const Component = current ? DRAWERS[current.entity] : null;
  return (
    <Sheet open={!!current} onOpenChange={(o) => !o && close()} title={current ? `${current.entity} details` : 'Details'} header={null}>
      {current && Component ? <Component id={current.id} /> : null}
    </Sheet>
  );
}

/** Layout every drawer uses: sticky header (kicker, title, sub, tag, close) + padded body. */
export function DrawerLayout({
  kicker,
  title,
  sub,
  tag,
  tagVariant = 'accent',
  children,
}: {
  kicker: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  tag?: ReactNode;
  tagVariant?: 'accent' | 'neutral' | 'outline' | 'ink';
  children: ReactNode;
}) {
  const { close } = useDrawer();
  return (
    <>
      <div className="sticky top-0 bg-white border-b border-divider px-[22px] py-4 flex justify-between gap-3 z-[1]">
        <div className="min-w-0">
          <Kicker>{kicker}</Kicker>
          <h2 className="mt-0.5 mb-0.5 text-[26px]">{title}</h2>
          {sub && <div className="text-[13px] text-neutral-700">{sub}</div>}
        </div>
        <div className="flex gap-2 items-start">
          {tag && <Tag variant={tagVariant}>{tag}</Tag>}
          <Button variant="secondary" size="iconSm" className="w-8 h-8" onClick={close} aria-label="Close">
            <Icon name="x" size={14} />
          </Button>
        </div>
      </div>
      <div className="px-[22px] pt-[18px] pb-10 grid gap-4">{children}</div>
    </>
  );
}

export function DrawerLoading() {
  return (
    <div className="px-[22px] py-5 grid gap-4">
      <Skeleton className="h-8 w-1/2" />
      <div className="grid grid-cols-4 gap-2.5">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-16" />
        ))}
      </div>
      <Skeleton className="h-40" />
      <Skeleton className="h-40" />
    </div>
  );
}
