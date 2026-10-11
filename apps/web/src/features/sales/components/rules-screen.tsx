'use client';

import { salesContract, type RuleRow } from '@exatech/contracts';
import { Button, Card, CardTitle, Checkbox, Dialog, EmptyState, Field, Icon, Input, Issue, Page, PageHeader, Select, Skeleton, Table, TableScroll, Tag, TD, TH } from '@exatech/ui';
import { useEffect, useState } from 'react';
import type { ApiResult } from '@/lib/api';
import { useApi, useApiMutation } from '@/lib/hooks';

type RulesData = ApiResult<typeof salesContract.rules>;

function MultiCheck({ label, options, value, onChange }: { label: string; options: { value: string; label: string }[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset className="grid gap-1.5 border border-divider p-2.5 m-0 min-w-0">
      <legend className="text-xs text-ink/70 px-1">{label}</legend>
      <div className="flex gap-x-4 gap-y-1.5 flex-wrap">
        {options.map((o) => (
          <Checkbox key={o.value} checked={value.includes(o.value)} onChange={(c) => onChange(c ? [...value, o.value] : value.filter((x) => x !== o.value))} label={o.label} />
        ))}
      </div>
    </fieldset>
  );
}

function RuleDialog({ data, rule, open, onOpenChange }: { data: RulesData; rule: RuleRow | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [name, setName] = useState('');
  const [sources, setSources] = useState<string[]>([]);
  const [courseIds, setCourseIds] = useState<string[]>([]);
  const [branchIds, setBranchIds] = useState<string[]>([]);
  const [assignees, setAssignees] = useState<string[]>([]);
  const [strategy, setStrategy] = useState<'single' | 'round_robin'>('round_robin');
  const [fallback, setFallback] = useState('—');
  useEffect(() => {
    if (!open) return;
    setName(rule?.name ?? '');
    setSources(rule?.condition.sources ?? []);
    setCourseIds(rule?.condition.courseIds ?? []);
    setBranchIds(rule?.condition.preferredBranchIds ?? []);
    setAssignees(rule?.assigneeUserIds ?? []);
    setStrategy(rule?.strategy ?? 'round_robin');
    setFallback(rule?.fallback ?? '—');
  }, [open, rule]);
  const done = { invalidate: [['sales']] as string[][], onSuccess: () => onOpenChange(false) };
  const create = useApiMutation(salesContract.createRule, { ...done, success: 'Rule added' });
  const update = useApiMutation(salesContract.updateRule, { ...done, success: 'Rule saved' });
  const isDefault = !!rule?.isDefault;
  const noCondition = !isDefault && !sources.length && !courseIds.length && !branchIds.length;
  const body = { name: name.trim(), condition: { sources, courseIds, preferredBranchIds: branchIds }, assigneeUserIds: assignees, strategy, fallback };
  const blocked = name.trim().length < 2 ? 'Name the rule' : noCondition ? 'Add at least one condition — the default rule already catches everything else' : assignees.length === 0 ? 'Pick at least one salesperson' : null;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      kicker={`Assignment rule · ${data.branchName}`}
      title={rule ? `Edit rule #${rule.position}` : 'Add rule'}
      width={600}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={create.isPending || update.isPending} disabled={!!blocked} onClick={() => (rule ? update.mutate({ params: { id: rule.id }, body }) : create.mutate({ body }))}>
            {rule ? 'Save rule' : 'Add rule'}
          </Button>
        </>
      }
    >
      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Instagram · Digital Marketing" autoFocus />
      </Field>
      {isDefault ? (
        <div className="text-[13px] text-neutral-700">Default rule · matches every lead no other rule catches.</div>
      ) : (
        <>
          <MultiCheck label="When source is" options={data.sources.map((x) => ({ value: x, label: x }))} value={sources} onChange={setSources} />
          <MultiCheck label="When course is" options={data.courses.map((c) => ({ value: c.id, label: c.name }))} value={courseIds} onChange={setCourseIds} />
          <MultiCheck label="When preferred branch is" options={data.branches.map((b) => ({ value: b.id, label: b.name }))} value={branchIds} onChange={setBranchIds} />
        </>
      )}
      <MultiCheck label="Assign to" options={data.team.map((t) => ({ value: t.id, label: `${t.name}${t.onLeave ? ' (on leave)' : ''}` }))} value={assignees} onChange={setAssignees} />
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="Strategy">
          <Select value={strategy} onChange={(e) => setStrategy(e.target.value as typeof strategy)} options={[{ value: 'round_robin', label: 'Round robin' }, { value: 'single', label: 'First available' }]} />
        </Field>
        <Field label="Fallback">
          <Select value={fallback} onChange={(e) => setFallback(e.target.value)} options={['—', 'Round robin', 'Any']} />
        </Field>
      </div>
      <div className="text-xs text-neutral-600">People on leave are skipped; round robin continues with the next available person.</div>
      {blocked && <Issue kind="needed">{blocked}</Issue>}
    </Dialog>
  );
}

function ReassignCard({ data }: { data: RulesData }) {
  const away = data.team.find((t) => t.onLeave) ?? data.team[0];
  const [from, setFrom] = useState(away?.id ?? '');
  const [to, setTo] = useState('');
  const [which, setWhich] = useState<'open' | 'overdue'>('open');
  const fromM = data.team.find((t) => t.id === from);
  const toOptions = data.team.filter((t) => t.id !== from && !t.onLeave);
  useEffect(() => {
    if (!toOptions.some((t) => t.id === to)) setTo(toOptions[0]?.id ?? '');
  }, [from]); // eslint-disable-line react-hooks/exhaustive-deps
  const n = fromM ? (which === 'open' ? fromM.openLeads : fromM.overdueLeads) : 0;
  const m = useApiMutation(salesContract.reassign, { invalidate: [['sales']], success: (r) => `${r.count} lead${r.count === 1 ? '' : 's'} reassigned` });
  return (
    <Card className="gap-2.5">
      <CardTitle>Reassign leads</CardTitle>
      <div className="grid gap-2.5 items-end" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))' }}>
        <Field label="From">
          <Select value={from} onChange={(e) => setFrom(e.target.value)} options={data.team.map((t) => ({ value: t.id, label: `${t.name}${t.onLeave ? ' (on leave)' : ''}` }))} />
        </Field>
        <Field label="To">
          <Select value={to} onChange={(e) => setTo(e.target.value)} options={toOptions.map((t) => ({ value: t.id, label: t.name }))} />
        </Field>
        <Field label="Which leads">
          <Select
            value={which}
            onChange={(e) => setWhich(e.target.value as typeof which)}
            options={[
              { value: 'open', label: `Open leads (${fromM?.openLeads ?? 0})` },
              { value: 'overdue', label: `Overdue follow-ups only (${fromM?.overdueLeads ?? 0})` },
            ]}
          />
        </Field>
        <Button variant="primary" disabled={!from || !to || n === 0} loading={m.isPending} onClick={() => m.mutate({ body: { fromUserId: from, toUserId: to, which } })}>
          Reassign {n}
        </Button>
      </div>
      {n === 0 && fromM && <div className="text-xs text-neutral-600">{fromM.name} has no {which === 'open' ? 'open leads' : 'overdue follow-ups'} in this branch.</div>}
    </Card>
  );
}

/** Sales Manager · Assignment rules — evaluated top-down; reorder, toggle, edit; bulk reassignment. */
export function RulesScreen() {
  const q = useApi(salesContract.rules, {});
  const [edit, setEdit] = useState<{ rule: RuleRow | null } | null>(null);
  const toggle = useApiMutation(salesContract.toggleRule, { invalidate: [['sales']], success: (_d, a) => (a.body.enabled ? 'Rule switched on' : 'Rule switched off') });
  const move = useApiMutation(salesContract.moveRule, { invalidate: [['sales']], success: false });
  const remove = useApiMutation(salesContract.deleteRule, { invalidate: [['sales']], success: 'Rule deleted' });
  const d = q.data;
  const movable = d?.rules.filter((r) => !r.isDefault) ?? [];
  return (
    <Page label="Sales Manager · Assignment rules">
      <PageHeader
        kicker="Evaluated top to bottom on lead creation"
        title="Assignment rules"
        actions={
          <Button variant="primary" disabled={!d} onClick={() => setEdit({ rule: null })}>
            Add rule
          </Button>
        }
      />
      <Card pad="none">
        <TableScroll minWidth={880}>
          <Table>
            <thead>
              <tr>
                <TH>#</TH>
                <TH>When</TH>
                <TH>Assign</TH>
                <TH>Fallback</TH>
                <TH>Matched (30 d)</TH>
                <TH>Status</TH>
                <TH className="text-right pr-4">Actions</TH>
              </tr>
            </thead>
            <tbody>
              {!d &&
                Array.from({ length: 4 }, (_, i) => (
                  <tr key={i}>
                    <TD colSpan={7}>
                      <Skeleton className="h-6" />
                    </TD>
                  </tr>
                ))}
              {d?.rules.map((r) => {
                const idx = movable.findIndex((x) => x.id === r.id);
                return (
                  <tr key={r.id} className={r.enabled ? undefined : 'text-neutral-500'}>
                    <TD className="tabular">{r.position}</TD>
                    <TD>
                      {r.whenLabel}
                      <div className="text-xs text-neutral-600">{r.name}</div>
                    </TD>
                    <TD>{r.assignLabel}</TD>
                    <TD>{r.fallback}</TD>
                    <TD className="tabular">{r.matched.toLocaleString('en-IN')}</TD>
                    <TD>{r.isDefault ? <Tag variant="neutral">Default</Tag> : r.enabled ? <Tag variant="accent">On</Tag> : <Tag variant="plain">Off</Tag>}</TD>
                    <TD className="pr-4">
                      <div className="flex gap-1 justify-end">
                        <Button size="iconSm" variant="secondary" aria-label={`Move ${r.name} up`} disabled={r.isDefault || idx <= 0} onClick={() => move.mutate({ params: { id: r.id }, body: { direction: 'up' } })}>
                          <Icon name="chevronDown" className="rotate-180" />
                        </Button>
                        <Button size="iconSm" variant="secondary" aria-label={`Move ${r.name} down`} disabled={r.isDefault || idx === movable.length - 1} onClick={() => move.mutate({ params: { id: r.id }, body: { direction: 'down' } })}>
                          <Icon name="chevronDown" />
                        </Button>
                        {!r.isDefault && (
                          <Button size="sm" variant="secondary" onClick={() => toggle.mutate({ params: { id: r.id }, body: { enabled: !r.enabled } })}>
                            {r.enabled ? 'Turn off' : 'Turn on'}
                          </Button>
                        )}
                        <Button size="sm" variant="secondary" onClick={() => setEdit({ rule: r })}>
                          Edit
                        </Button>
                        <Button size="iconSm" variant="secondary" aria-label={`Delete ${r.name}`} disabled={r.isDefault} title={r.isDefault ? 'The default rule cannot be deleted' : undefined} onClick={() => remove.mutate({ params: { id: r.id } })}>
                          <Icon name="trash" />
                        </Button>
                      </div>
                    </TD>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </TableScroll>
        {q.error && <EmptyState title="Could not load rules" body={q.error.message} />}
        {d && <div className="px-4 py-2 text-xs text-neutral-600 border-t border-divider">The default rule runs last and cannot be deleted or switched off.</div>}
      </Card>
      {d && <ReassignCard data={d} />}
      {d && <RuleDialog data={d} rule={edit?.rule ?? null} open={!!edit} onOpenChange={(o) => !o && setEdit(null)} />}
    </Page>
  );
}
