'use client';

import { searchContract, type SearchItem } from '@exatech/contracts';
import { Corners, Icon } from '@exatech/ui';
import { Command } from 'cmdk';
import { Dialog as D } from 'radix-ui';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useApi } from '@/lib/hooks';
import { useDrawer } from '../drawers/drawer-context';

/** ⌘K: students, leads, invoices, batches, teachers, branches and actions — scope respected server-side. */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const router = useRouter();
  const drawer = useDrawer();

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 200);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const { data, isFetching } = useApi(searchContract.search, { query: { q: debounced } }, { enabled: open, staleTime: 10_000, placeholderData: (prev) => prev });

  const go = (item: SearchItem) => {
    onOpenChange(false);
    if (item.drawer) drawer.open(item.drawer.entity, item.drawer.id);
    else if (item.href) router.push(item.href);
  };

  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-neutral-900/40 animate-fade" />
        <D.Content className="fixed z-50 left-1/2 top-[12vh] -translate-x-1/2 w-[min(560px,92vw)] bg-white border border-divider shadow-lg animate-rise focus:outline-none">
          <Corners />
          <D.Title className="sr-only">Search</D.Title>
          <D.Description className="sr-only">Jump to a student, lead, batch or action</D.Description>
          <Command shouldFilter={false} label="Search">
            <div className="flex items-center gap-2.5 px-3.5 py-3 border-b border-divider">
              <Icon name="search" />
              <Command.Input
                autoFocus
                value={query}
                onValueChange={setQuery}
                placeholder="Jump to a student, lead, batch or action…"
                className="flex-1 border-0 outline-0 font-[inherit] text-[15px] bg-transparent"
              />
              <span className="text-[11px] text-neutral-500">{isFetching ? '…' : 'esc'}</span>
            </div>
            <Command.List className="p-2 grid gap-0.5 max-h-[60vh] overflow-auto">
              <Command.Empty className="px-2.5 py-4 text-[13px] text-neutral-600">{debounced.length < 2 ? 'Type two letters to search' : 'No matches in your scope'}</Command.Empty>
              {(data?.items ?? []).map((item, i) => (
                <Command.Item
                  key={`${item.kind}-${item.label}-${i}`}
                  value={`${item.kind}-${item.label}-${i}`}
                  onSelect={() => go(item)}
                  className="flex justify-between items-center gap-2 px-2.5 py-[9px] text-[13px] cursor-pointer data-[selected=true]:bg-accent-100"
                >
                  <span className="min-w-0 truncate">
                    <span className="text-[10px] tracking-[0.1em] uppercase text-accent mr-2.5">{item.kind}</span>
                    {item.label}
                  </span>
                  <span className="text-[11px] text-neutral-500 truncate max-w-[45%]">{item.meta}</span>
                </Command.Item>
              ))}
            </Command.List>
          </Command>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
