'use client';

import { teachingAttendanceContract, type TeachAttCounts } from '@exatech/contracts';
import { toast } from '@exatech/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, callApi } from '@/lib/api';

export type AttStatus = 'P' | 'A' | 'L' | 'E';
type Changes = Record<string, AttStatus>;

const storageKey = (sessionId: string) => `exa:attendance-queue:${sessionId}`;

function readQueue(sessionId: string): Changes {
  try {
    const raw = window.localStorage.getItem(storageKey(sessionId));
    return raw ? (JSON.parse(raw) as Changes) : {};
  } catch {
    return {};
  }
}

function writeQueue(sessionId: string, q: Changes) {
  try {
    if (Object.keys(q).length) window.localStorage.setItem(storageKey(sessionId), JSON.stringify(q));
    else window.localStorage.removeItem(storageKey(sessionId));
  } catch {
    /* storage full / private mode — the in-memory queue still syncs */
  }
}

/**
 * Optimistic attendance taps with a debounced server autosave. Taps made
 * while offline are kept per session in localStorage and synced when the
 * browser is back online (the server upsert is idempotent per
 * session + enrollment, so replays are safe).
 */
export function useAttendanceSync(sessionId: string | null, onSaved: (applied: Changes, res: { savedAt: string; counts: TeachAttCounts }) => void) {
  const [overlay, setOverlay] = useState<Changes>({});
  const [queued, setQueued] = useState(0);
  const [offline, setOffline] = useState(false);
  const [saving, setSaving] = useState(false);
  const queue = useRef<Changes>({});
  const inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedCb = useRef(onSaved);
  savedCb.current = onSaved;

  const flush = useCallback(async () => {
    if (!sessionId || inFlight.current) return;
    const snapshot = { ...queue.current };
    if (!Object.keys(snapshot).length) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setOffline(true);
      return;
    }
    inFlight.current = true;
    setSaving(true);
    try {
      const res = await callApi(teachingAttendanceContract.mark, {
        params: { id: sessionId },
        body: { marks: Object.entries(snapshot).map(([enrollmentId, status]) => ({ enrollmentId, status })) },
      });
      for (const [k, v] of Object.entries(snapshot)) if (queue.current[k] === v) delete queue.current[k];
      writeQueue(sessionId, queue.current);
      setQueued(Object.keys(queue.current).length);
      setOffline(false);
      savedCb.current(snapshot, res);
      setOverlay((o) => {
        const next = { ...o };
        for (const [k, v] of Object.entries(snapshot)) if (next[k] === v && !(k in queue.current)) delete next[k];
        return next;
      });
    } catch (err) {
      if (err instanceof ApiError) {
        // Refused by the server (edit window closed, not on roster…): drop and revert those taps.
        for (const k of Object.keys(snapshot)) delete queue.current[k];
        writeQueue(sessionId, queue.current);
        setQueued(Object.keys(queue.current).length);
        setOverlay((o) => {
          const next = { ...o };
          for (const k of Object.keys(snapshot)) delete next[k];
          return next;
        });
        toast.error(err.message);
      } else {
        setOffline(true);
      }
    } finally {
      inFlight.current = false;
      setSaving(false);
      if (Object.keys(queue.current).length && (typeof navigator === 'undefined' || navigator.onLine)) {
        timer.current = setTimeout(() => void flush(), 400);
      }
    }
  }, [sessionId]);

  // Load the persisted queue for this session and try to sync it.
  useEffect(() => {
    if (!sessionId) return;
    const q = readQueue(sessionId);
    queue.current = q;
    setOverlay(q);
    setQueued(Object.keys(q).length);
    setOffline(typeof navigator !== 'undefined' && !navigator.onLine && Object.keys(q).length > 0);
    if (Object.keys(q).length) void flush();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [sessionId, flush]);

  useEffect(() => {
    const online = () => {
      setOffline(false);
      void flush();
    };
    const off = () => setOffline(true);
    window.addEventListener('online', online);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', off);
    };
  }, [flush]);

  const set = useCallback(
    (changes: Changes) => {
      if (!sessionId) return;
      queue.current = { ...queue.current, ...changes };
      writeQueue(sessionId, queue.current);
      setQueued(Object.keys(queue.current).length);
      setOverlay((o) => ({ ...o, ...changes }));
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), 250);
    },
    [sessionId, flush],
  );

  /** Push anything pending now (before submitting). Resolves once the queue is empty or offline. */
  const drain = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    for (let i = 0; i < 20 && Object.keys(queue.current).length; i++) {
      if (inFlight.current) await new Promise((r) => setTimeout(r, 150));
      else await flush();
      if (typeof navigator !== 'undefined' && !navigator.onLine) break;
    }
    return Object.keys(queue.current).length === 0;
  }, [flush]);

  return { overlay, set, queued, offline: offline && queued > 0, saving, drain };
}
