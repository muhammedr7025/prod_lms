'use client';

import dynamic from 'next/dynamic';
import type { ComponentType } from 'react';
import type { DrawerEntity } from './drawer-context';
import { DrawerLoading } from './drawer-host';

/** Detail panels are code-split and only load when opened. */
export const DRAWERS: Record<DrawerEntity, ComponentType<{ id: string }>> = {
  student: dynamic(() => import('@/features/students/student-drawer'), { loading: DrawerLoading }),
  teacher: dynamic(() => import('@/features/staff/teacher-drawer'), { loading: DrawerLoading }),
  branch: dynamic(() => import('@/features/branches/branch-drawer'), { loading: DrawerLoading }),
  exam: dynamic(() => import('@/features/marks/exam-drawer'), { loading: DrawerLoading }),
};
