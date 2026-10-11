'use client';

import { institutionRolesContract, MATRIX_RESOURCES, matrixCell, PERMISSIONS, ROLE_META, SUPERADMIN_LOCKED_PERMISSIONS, SYSTEM_ROLES, type InstRole } from '@exatech/contracts';
import { Button, Card, CardBody, CardTitle, Checkbox, Dialog, EmptyState, Field, Grid, Icon, Input, Issue, Kicker, Page, PageHeader, Select, Skeleton, Table, TableScroll, Tag, TD, TH, cn } from '@exatech/ui';
import { useEffect, useMemo, useState } from 'react';
import { useMe } from '@/components/me-context';
import { apiErrors, type FieldErrors } from '@/features/institution/components/parts';
import { useApi, useApiMutation } from '@/lib/hooks';

const LABEL = new Map<string, string>(PERMISSIONS.map((p) => [p.key, p.label]));
const SCOPE_OPTIONS = [
  { value: 'branch', label: 'Branch — the branches on the membership' },
  { value: 'institution', label: 'Institution — every branch' },
  { value: 'batch', label: 'Batch — assigned batches only' },
  { value: 'own', label: 'Own — records they own' },
];

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');

/** Order: system roles in ROLE_META order, then custom roles. */
function ordered(roles: InstRole[]): InstRole[] {
  const rank = (r: InstRole) => {
    const i = (SYSTEM_ROLES as readonly string[]).indexOf(r.key);
    return i >= 0 ? i : 100 + r.position;
  };
  return [...roles].sort((a, b) => rank(a) - rank(b));
}

const shortName = (r: InstRole) => (r.isSystem ? (ROLE_META[r.key as keyof typeof ROLE_META]?.short ?? r.name) : r.name);

/** Roles & permissions: the matrix (role × resource), per-role permission editor, new role, rule cards. */
export function RolesScreen() {
  const me = useMe();
  const { data, isPending, error } = useApi(institutionRolesContract.list, {});
  const [draft, setDraft] = useState<Record<string, string[]>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const roles = useMemo(() => ordered(data?.roles ?? []), [data]);
  const permsOf = (r: InstRole) => draft[r.id] ?? r.permissions;
  const changed = roles.filter((r) => draft[r.id] && !same(draft[r.id]!, r.permissions));
  const superRole = roles.find((r) => r.key === 'superadmin');
  const lockedMissing = superRole ? SUPERADMIN_LOCKED_PERMISSIONS.filter((p) => !permsOf(superRole).includes(p)) : [];
  const myRole = roles.find((r) => r.key === me.membership.roleKey);
  const selfLock = myRole && myRole.key !== 'superadmin' && !permsOf(myRole).includes('institution:roles.manage');
  const blocked = lockedMissing.length
    ? `Super Admin must keep “${lockedMissing.map((p) => LABEL.get(p)).join('” and “')}” — without it nobody could change roles or decide approvals.`
    : selfLock
      ? `You would lose “${LABEL.get('institution:roles.manage')}” on the role you are using.`
      : null;

  const save = useApiMutation(institutionRolesContract.saveMatrix, {
    invalidate: [['institution', 'roles'], ['me']],
    success: (r) => `Matrix saved · ${r.length} role${r.length === 1 ? '' : 's'} updated · applies immediately`,
    toastError: false,
    onError: (e) => setSaveError(e.message),
    onSuccess: () => {
      setDraft({});
      setSaveError(null);
    },
  });
  const remove = useApiMutation(institutionRolesContract.remove, {
    invalidate: [['institution', 'roles']],
    success: 'Role deleted',
    onSuccess: () => setEditing(null),
  });
  useEffect(() => setSaveError(null), [draft]);

  const editingRole = roles.find((r) => r.id === editing) ?? null;
  const t = data?.thresholds;

  return (
    <Page label="Super Admin · Roles">
      <PageHeader
        kicker="Access = role × scope"
        title="Roles & permissions"
        actions={
          <>
            <Button variant="secondary" onClick={() => setCreating(true)}>
              New role
            </Button>
            <Button
              variant="primary"
              disabled={changed.length === 0 || !!blocked}
              loading={save.isPending}
              onClick={() => save.mutate({ body: { changes: changed.map((r) => ({ roleId: r.id, permissions: draft[r.id]! })) } })}
            >
              {changed.length ? `Save matrix · ${changed.length}` : 'Save matrix'}
            </Button>
          </>
        }
      />
      {(blocked || saveError) && (
        <div className="grid gap-1.5" data-testid="matrix-issue">
          {blocked && <Issue>{blocked}</Issue>}
          {saveError && <Issue>{saveError}</Issue>}
        </div>
      )}
      {changed.length > 0 && !blocked && <div className="text-xs text-neutral-600 -mt-2">Unsaved: {changed.map((r) => r.name).join(', ')} · changes apply as soon as you save.</div>}
      {error && <EmptyState title="Could not load roles" body={error.message} />}

      <Card pad="none">
        <TableScroll minWidth={Math.max(900, 180 + roles.length * 110)}>
          <Table data-testid="permission-matrix">
            <thead>
              <tr>
                <TH>Resource</TH>
                {roles.map((r) => (
                  <TH key={r.id} className={cn('normal-case tracking-normal', editing === r.id && 'bg-accent-100')}>
                    <button
                      type="button"
                      onClick={() => setEditing(r.id)}
                      className="border-0 bg-transparent p-0 font-[inherit] cursor-pointer text-[11px] tracking-[0.08em] uppercase text-ink/70 hover:text-accent-800 underline-offset-[3px] hover:underline text-left"
                      aria-label={`Edit ${r.name} permissions`}
                    >
                      {shortName(r)}
                      <Icon name="edit" size={10} className="inline ml-1 -mt-0.5 opacity-50" />
                      {draft[r.id] && !same(draft[r.id]!, r.permissions) && <span className="text-accent-700"> •</span>}
                    </button>
                    {!r.isSystem && <div className="text-[10px] normal-case tracking-normal text-neutral-500">custom · {r.members} member{r.members === 1 ? '' : 's'}</div>}
                  </TH>
                ))}
              </tr>
            </thead>
            <tbody>
              {isPending &&
                Array.from({ length: 6 }, (_, i) => (
                  <tr key={i}>
                    <TD colSpan={9}>
                      <Skeleton className="h-5" />
                    </TD>
                  </tr>
                ))}
              {data &&
                MATRIX_RESOURCES.map((res) => (
                  <tr key={res} data-testid="matrix-row">
                    <TD className="font-medium">{res}</TD>
                    {roles.map((r) => {
                      const cell = matrixCell(permsOf(r), res, r.scopeKind);
                      const before = matrixCell(r.permissions, res, r.scopeKind);
                      return (
                        <TD key={r.id} className={cn('tabular whitespace-nowrap', cell !== before && 'bg-accent-100 font-medium', editing === r.id && cell === before && 'bg-accent-100/50')} data-role={r.key}>
                          {cell}
                        </TD>
                      );
                    })}
                  </tr>
                ))}
            </tbody>
          </Table>
        </TableScroll>
        <div className="px-4 py-2.5 text-xs text-neutral-600 border-t border-divider">
          C create · R read · U update · D delete · A approve · Scope applies on top (branch, batch, own, child). Least privilege: new roles start empty. Select a role to edit its permissions.
        </div>
      </Card>

      <Grid min={260} gap={14}>
        <Card pad="lg" className="gap-1.5">
          <Kicker>Rule</Kicker>
          <CardTitle>Marks publishing is two-step</CardTitle>
          <CardBody>Teacher submits, Branch Admin publishes. Draft marks are never visible to students or parents.</CardBody>
        </Card>
        <Card pad="lg" className="gap-1.5">
          <Kicker>Thresholds</Kicker>
          <CardTitle>Discount approvals</CardTitle>
          <CardBody>{t ? `Above ${t.financePct}% → Finance Manager. Above ${t.superAdminPct}% → Super Admin. Every override carries a reason code.` : <Skeleton className="h-8" />}</CardBody>
        </Card>
        <Card pad="lg" className="gap-1.5">
          <Kicker>Impersonation</Kicker>
          <CardTitle>View as student</CardTitle>
          <CardBody>Read-only, time-boxed to {data?.impersonationMinutes ?? 15} minutes, written to the audit log with actor and reason.</CardBody>
        </Card>
      </Grid>

      {editingRole && (
        <PermissionsDialog
          role={editingRole}
          value={permsOf(editingRole)}
          onChange={(next) => setDraft((d) => ({ ...d, [editingRole.id]: next }))}
          onReset={() =>
            setDraft((d) => {
              const { [editingRole.id]: _drop, ...rest } = d;
              void _drop;
              return rest;
            })
          }
          onClose={() => setEditing(null)}
          blocked={editingRole.key === 'superadmin' && lockedMissing.length ? blocked : null}
          onDelete={editingRole.isSystem ? null : () => remove.mutate({ params: { id: editingRole.id } })}
          deleting={remove.isPending}
          deleteError={remove.error?.message ?? null}
        />
      )}
      <NewRoleDialog open={creating} onClose={() => setCreating(false)} onCreated={(r) => setEditing(r.id)} />
    </Page>
  );
}

function PermissionsDialog({
  role,
  value,
  onChange,
  onReset,
  onClose,
  blocked,
  onDelete,
  deleting,
  deleteError,
}: {
  role: InstRole;
  value: string[];
  onChange: (next: string[]) => void;
  onReset: () => void;
  onClose: () => void;
  blocked: string | null;
  onDelete: (() => void) | null;
  deleting: boolean;
  deleteError: string | null;
}) {
  const dirty = !same(value, role.permissions);
  const toggle = (key: string, on: boolean) => onChange(on ? [...value, key] : value.filter((k) => k !== key));
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      width={760}
      kicker={`${role.isSystem ? 'System role' : 'Custom role'} · ${role.scopeKind} scope · ${role.members} member${role.members === 1 ? '' : 's'}`}
      title={`${role.name} · permissions`}
      description="Tick what this role may do; scope (branch, batch, own) is applied on top. Changes are staged — press Save matrix to apply them."
      footerAlign="between"
      footer={
        <>
          <div className="flex gap-2">
            {onDelete && (
              <Button variant="ghost" disabled={role.members > 0} loading={deleting} onClick={onDelete} title={role.members > 0 ? 'Change their memberships first' : undefined}>
                Delete role
              </Button>
            )}
            {dirty && (
              <Button variant="ghost" onClick={onReset}>
                Undo changes
              </Button>
            )}
          </div>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      {blocked && <Issue>{blocked}</Issue>}
      {onDelete && role.members > 0 && <Issue kind="needed">{`${role.members} ${role.members === 1 ? 'person holds' : 'people hold'} this role — change their memberships before deleting it.`}</Issue>}
      {deleteError && <Issue>{deleteError}</Issue>}
      <div className="grid sm:grid-cols-2 gap-x-6 gap-y-3 max-h-[58vh] overflow-auto pr-1">
        {MATRIX_RESOURCES.map((res) => {
          const defs = PERMISSIONS.filter((p) => p.resource === res);
          return (
            <div key={res} className="grid gap-1 content-start">
              <div className="flex justify-between items-center border-b border-divider pb-1">
                <Kicker>{res}</Kicker>
                <Tag variant="neutral" size="sm">
                  {matrixCell(value, res, role.scopeKind)}
                </Tag>
              </div>
              {defs.map((p) => {
                const locked = role.key === 'superadmin' && (SUPERADMIN_LOCKED_PERMISSIONS as readonly string[]).includes(p.key);
                return (
                  <Checkbox
                    key={p.key}
                    align="start"
                    checked={value.includes(p.key)}
                    onChange={(on) => toggle(p.key, on)}
                    label={
                      <span>
                        {p.label} <span className="text-[10px] text-neutral-500">· {p.letter}</span>
                        {locked && <span className="text-[10px] text-neutral-500"> · required for Super Admin</span>}
                      </span>
                    }
                  />
                );
              })}
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}

function NewRoleDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (r: InstRole) => void }) {
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [scopeKind, setScopeKind] = useState<'institution' | 'branch' | 'batch' | 'own'>('branch');
  const [surface, setSurface] = useState<'staff' | 'portal'>('staff');
  const [errors, setErrors] = useState<FieldErrors>({});
  useEffect(() => {
    if (open) {
      setName('');
      setKey('');
      setKeyTouched(false);
      setScopeKind('branch');
      setSurface('staff');
      setErrors({});
    }
  }, [open]);
  const slug = (v: string) =>
    v
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 30);
  const create = useApiMutation(institutionRolesContract.create, {
    invalidate: [['institution', 'roles']],
    success: (r) => `${r.name} created · starts with no permissions`,
    toastError: false,
    onError: (e) => setErrors(apiErrors(e)),
    onSuccess: (r) => {
      onClose();
      onCreated(r);
    },
  });
  const submit = () => {
    const body = { key, name, scopeKind, surface };
    create.mutate({ body });
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      width={480}
      kicker="Least privilege"
      title="New role"
      description="New roles start with no permissions. Tick what they need in the matrix, then give people a membership."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={create.isPending} onClick={submit}>
            Create role
          </Button>
        </>
      }
    >
      <Field label="Name" error={errors.name}>
        <Input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (!keyTouched) setKey(slug(e.target.value));
          }}
          placeholder="Front desk"
          autoFocus
        />
      </Field>
      <Field label="Key" error={errors.key} hint="Lowercase slug, used in audit entries">
        <Input
          value={key}
          onChange={(e) => {
            setKeyTouched(true);
            setKey(e.target.value);
          }}
          placeholder="front_desk"
        />
      </Field>
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="Scope" error={errors.scopeKind}>
          <Select value={scopeKind} onChange={(e) => setScopeKind(e.target.value as typeof scopeKind)} options={SCOPE_OPTIONS} />
        </Field>
        <Field label="Surface" error={errors.surface}>
          <Select
            value={surface}
            onChange={(e) => setSurface(e.target.value as typeof surface)}
            options={[
              { value: 'staff', label: 'Staff · desktop' },
              { value: 'portal', label: 'Portal · mobile' },
            ]}
          />
        </Field>
      </div>
      {errors._ && !errors.name && !errors.key && <Issue>{errors._}</Issue>}
    </Dialog>
  );
}
