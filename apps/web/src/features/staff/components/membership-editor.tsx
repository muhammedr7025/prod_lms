'use client';

import type { InstRoleOption, MembershipInput } from '@exatech/contracts';
import { Button, Checkbox, Select, cn } from '@exatech/ui';

export interface MembershipDraft {
  key: number;
  roleId: string;
  branchIds: string[];
}

export const toDrafts = (list: { roleId: string; branchIds: string[] }[]): MembershipDraft[] => list.map((m, i) => ({ key: i + 1, roleId: m.roleId, branchIds: [...m.branchIds] }));
export const toInputs = (list: MembershipDraft[]): MembershipInput[] => list.filter((m) => m.roleId).map((m) => ({ roleId: m.roleId, branchIds: m.branchIds }));

const SCOPE_HINT: Record<string, string> = { institution: 'Institution-wide · every branch', branch: 'Branch scope', batch: 'Assigned batches in these branches', own: 'Own records in these branches', child: 'Linked children' };

/** Role × scope rows: pick a role, then the branches it covers (Super Admin = institution). */
export function MembershipEditor({
  value,
  onChange,
  roles,
  branches,
  error,
}: {
  value: MembershipDraft[];
  onChange: (next: MembershipDraft[]) => void;
  roles: InstRoleOption[];
  branches: { id: string; code: string; name: string }[];
  error?: string | null;
}) {
  const update = (key: number, patch: Partial<MembershipDraft>) => onChange(value.map((m) => (m.key === key ? { ...m, ...patch } : m)));
  return (
    <div className="grid gap-2">
      {value.map((m, i) => {
        const role = roles.find((r) => r.id === m.roleId);
        const used = new Set(value.filter((x) => x.key !== m.key).map((x) => x.roleId));
        return (
          <div key={m.key} className="grid gap-1.5 border border-divider p-2.5 bg-surface" data-testid="membership-row">
            <div className="flex gap-2 items-center">
              <Select
                aria-label={`Membership ${i + 1} role`}
                className="flex-1"
                tone="white"
                value={m.roleId}
                placeholder="Choose a role…"
                onChange={(e) => {
                  const r = roles.find((x) => x.id === e.target.value);
                  update(m.key, { roleId: e.target.value, branchIds: r?.scopeKind === 'institution' ? [] : m.branchIds });
                }}
                options={roles.map((r) => ({ value: r.id, label: r.isSystem ? r.name : `${r.name} (custom)`, disabled: used.has(r.id) }))}
              />
              <Button variant="secondary" size="iconSm" aria-label={`Remove membership ${i + 1}`} onClick={() => onChange(value.filter((x) => x.key !== m.key))}>
                ×
              </Button>
            </div>
            {role && <div className="text-[11px] text-neutral-600">{SCOPE_HINT[role.scopeKind] ?? role.scopeKind}</div>}
            {role && role.scopeKind !== 'institution' && (
              <div className="flex gap-x-4 gap-y-1.5 flex-wrap" role="group" aria-label={`Membership ${i + 1} branches`}>
                {branches.map((b) => (
                  <Checkbox
                    key={b.id}
                    checked={m.branchIds.includes(b.id)}
                    onChange={(on) => update(m.key, { branchIds: on ? [...m.branchIds, b.id] : m.branchIds.filter((x) => x !== b.id) })}
                    label={`${b.name} (${b.code})`}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
      <div className={cn('flex items-center gap-2', value.length === 0 && 'border border-dashed border-divider p-2.5')}>
        <Button variant="ghost" size="sm" onClick={() => onChange([...value, { key: Date.now(), roleId: '', branchIds: [] }])}>
          + Add membership
        </Button>
        {value.length === 0 && <span className="text-[12px] text-neutral-600">New memberships start empty and inherit nothing.</span>}
      </div>
      {error && (
        <div role="alert" className="text-[12px] text-ink font-medium">
          {error}
        </div>
      )}
    </div>
  );
}
