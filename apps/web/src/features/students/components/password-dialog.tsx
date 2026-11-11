'use client';

import { academicsStudentsContract, type AcadStudentDetail } from '@exatech/contracts';
import { Button, Dialog, Field, Input, Issue, toast } from '@exatech/ui';
import { useEffect, useState } from 'react';
import { useApiMutation } from '@/lib/hooks';
import { apiErrors, type FieldErrors } from '@/features/institution/components/parts';

/** 8 letters + 2 digits from an alphabet without look-alikes (no 0/O, 1/l/I), shuffled. */
function generatePassword(): string {
  const letters = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const pick = (set: string, n: number) => Array.from(crypto.getRandomValues(new Uint32Array(n)), (v) => set[v % set.length]!);
  const chars = [...pick(letters, 8), ...pick(digits, 2)];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0]! % (i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

/** Admin gives a student a password (first one, or a reset). The student changes it at their first sign-in. */
export function SetPasswordDialog({ student, open, onClose }: { student: AcadStudentDetail; open: boolean; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [mustChange, setMustChange] = useState(true);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [done, setDone] = useState<{ signInWith: string[]; password: string; mustChange: boolean } | null>(null);
  useEffect(() => {
    if (open) {
      setPassword('');
      setMustChange(true);
      setErrors({});
      setDone(null);
    }
  }, [open]);

  const save = useApiMutation(academicsStudentsContract.setPassword, {
    invalidate: [['academics']],
    toastError: false,
    onError: (e) => setErrors(apiErrors(e)),
    onSuccess: (r) => setDone({ signInWith: r.signInWith, password, mustChange: r.mustChange }),
  });

  const submit = () => {
    if (password.length < 8) return setErrors({ password: 'Use at least 8 characters' });
    setErrors({});
    save.mutate({ params: { id: student.id }, body: { password, mustChange } });
  };
  const copy = async () => {
    if (!done) return;
    const text = `Exatech sign-in\nUsername: ${done.signInWith.join(' or ')}\nPassword: ${done.password}${done.mustChange ? '\n(You will be asked to choose your own password the first time.)' : ''}`;
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied — paste it into a message to the student');
    } catch {
      toast.error('Could not copy — select the text and copy it');
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      width={480}
      kicker={`Student · ${student.admissionNo ?? student.name}`}
      title={done ? 'Password set' : `Password for ${student.name}`}
      description={done ? undefined : 'Gives the student a way to sign in with a password. They are signed out everywhere, and this password replaces any earlier one.'}
      footer={
        done ? (
          <>
            <Button variant="secondary" onClick={copy}>
              Copy details
            </Button>
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" loading={save.isPending} onClick={submit}>
              Set password
            </Button>
          </>
        )
      }
    >
      {done ? (
        <div className="grid gap-2.5 text-[13px]" data-testid="password-set">
          <Issue kind="ok">{done.mustChange ? 'The student must choose their own password at the first sign-in.' : 'The student can keep this password, or change it later from the account menu.'}</Issue>
          <div className="border border-divider bg-surface px-3 py-2.5 grid gap-1">
            <div>
              <span className="text-neutral-600">Username · </span>
              <b className="font-medium">{done.signInWith.join(' or ') || '—'}</b>
            </div>
            <div>
              <span className="text-neutral-600">Password · </span>
              <b className="font-mono font-medium" data-testid="password-shown">
                {done.password}
              </b>
            </div>
          </div>
          <div className="text-neutral-600">Shown only now — it is not stored anywhere you can read it back. Give it to the student privately (not in a group chat).</div>
        </div>
      ) : (
        <form
          className="grid gap-3.5"
          onSubmit={(ev) => {
            ev.preventDefault();
            submit();
          }}
        >
          {!student.userId && <Issue kind="blocked">This student has no sign-in account yet.</Issue>}
          <div className="flex gap-1.5 items-start">
            <Field
              label="Password"
              className="flex-1"
              error={errors.password ?? (errors._ && Object.keys(errors).length === 1 ? errors._ : undefined)}
              hint="At least 8 characters, with letters and numbers"
            >
              <Input value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" spellCheck={false} invalid={!!errors.password} className="font-mono" />
            </Field>
            <Button type="button" variant="secondary" className="mt-[19px]" onClick={() => setPassword(generatePassword())}>
              Generate
            </Button>
          </div>
          <label className="flex items-start gap-2 text-[13px] cursor-pointer">
            <input type="checkbox" checked={mustChange} onChange={(e) => setMustChange(e.target.checked)} className="mt-0.5" />
            <span>
              Student must choose their own password at the first sign-in <span className="text-neutral-600">(recommended — only the student should know it)</span>
            </span>
          </label>
          {!mustChange && <div className="text-[12px] text-neutral-700">Without this, the student keeps the password you set, so use a strong one (the full password rules apply).</div>}
        </form>
      )}
    </Dialog>
  );
}
