'use client';

import { DOCUMENT_PATHS } from '@exatech/contracts';
import { formatINR } from '@exatech/domain';
import { Kicker, Tag } from '@exatech/ui';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';
import type { Row } from './pay-sheet';

/** Checkmark draws on, receipt card slides up, fee badge morphs Overdue → Paid (400 ms; static under reduced motion). */
export function PaidView({ rows, from }: { rows: Row[]; from: string }) {
  const reduce = useReducedMotion();
  const [morphed, setMorphed] = useState(!!reduce);
  useEffect(() => {
    if (reduce) return;
    const t = setTimeout(() => setMorphed(true), 450);
    return () => clearTimeout(t);
  }, [reduce]);
  const d = reduce ? 0 : 0.4;
  return (
    <div className="grid gap-3" data-testid="pay-success">
      <div className="flex items-center gap-3">
        <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden className="flex-none">
          <motion.circle cx="22" cy="22" r="20" fill="none" stroke="var(--color-accent)" strokeWidth="2" initial={{ pathLength: reduce ? 1 : 0 }} animate={{ pathLength: 1 }} transition={{ duration: d }} />
          <motion.path d="M13 22.5l6 6 12-13" fill="none" stroke="var(--color-accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" initial={{ pathLength: reduce ? 1 : 0 }} animate={{ pathLength: 1 }} transition={{ duration: d, delay: reduce ? 0 : 0.15 }} />
        </svg>
        <div className="min-w-0">
          <Kicker>Payment received</Kicker>
          <div className="text-[13px]">Fee status</div>
        </div>
        <span className="flex-1" />
        <span className="relative inline-grid" aria-live="polite">
          <AnimatePresence initial={false} mode="popLayout">
            {!morphed ? (
              <motion.span key="before" exit={{ opacity: 0, scale: 0.9 }} transition={{ duration: 0.2 }}>
                <Tag variant="ink">{from}</Tag>
              </motion.span>
            ) : (
              <motion.span key="paid" initial={reduce ? false : { opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.2 }}>
                <Tag variant="accent" data-testid="fee-badge">
                  Paid
                </Tag>
              </motion.span>
            )}
          </AnimatePresence>
        </span>
      </div>
      {rows
        .filter((r) => r.status === 'paid')
        .map((r, i) => (
          <motion.div
            key={r.studentId}
            initial={reduce ? false : { y: 16, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: d, delay: reduce ? 0 : 0.1 + i * 0.08, ease: 'easeOut' }}
            className="relative border border-divider bg-surface p-3 grid gap-1"
            data-testid="pay-receipt"
          >
            <div className="flex justify-between gap-2 items-baseline">
              <span className="text-[13px] font-medium">{r.name}</span>
              <span className="font-heading font-semibold text-lg tabular">{formatINR(r.amount)}</span>
            </div>
            <div className="text-[13px]">
              Receipt <span className="font-mono text-xs">{r.receiptNumber ?? 'being issued…'}</span>
            </div>
            <div className="text-xs text-neutral-600">Receipt sent by WhatsApp + email · fee-gated notes unlock now</div>
            {r.receiptId && (
              <a href={DOCUMENT_PATHS.receipt(r.receiptId)} target="_blank" rel="noreferrer" className="text-[13px] text-accent-800 underline underline-offset-[3px] w-fit min-h-11 inline-flex items-center">
                Download receipt (PDF)
              </a>
            )}
          </motion.div>
        ))}
    </div>
  );
}
