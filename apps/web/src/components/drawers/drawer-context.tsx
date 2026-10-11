'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

export type DrawerEntity = 'student' | 'teacher' | 'branch' | 'exam';

export interface DrawerTarget {
  entity: DrawerEntity;
  id: string;
}

interface DrawerApi {
  current: DrawerTarget | null;
  open: (entity: DrawerEntity, id: string) => void;
  close: () => void;
}

const Ctx = createContext<DrawerApi | null>(null);

/** Detail panels (student, teacher, branch, exam) open from anywhere: tables, palette, at-risk rows. */
export function DrawerProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<DrawerTarget | null>(null);
  const open = useCallback((entity: DrawerEntity, id: string) => setCurrent({ entity, id }), []);
  const close = useCallback(() => setCurrent(null), []);
  const value = useMemo(() => ({ current, open, close }), [current, open, close]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDrawer(): DrawerApi {
  const c = useContext(Ctx);
  if (!c) throw new Error('useDrawer() outside <DrawerProvider>');
  return c;
}
