'use client';

import { AUTH_PATHS } from '@exatech/contracts';
import { Button, Card, Field, Input, Kicker } from '@exatech/ui';
import { useState } from 'react';
import { authPost } from '@/lib/api';

function safeNext(next: string) {
  return next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

/** Choose a new password. `forced`: an administrator set a temporary one, so this comes before anything else. */
export function PasswordForm({ next, forced }: { next: string; forced: boolean }) {
  const [current, setCurrent] = useState('');
  const [fresh, setFresh] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    if (!current) return setError(forced ? 'Enter the temporary password you were given' : 'Enter your current password');
    if (fresh !== again) return setError('The two new passwords are not the same');
    setBusy(true);
    try {
      await authPost(AUTH_PATHS.changePassword, { currentPassword: current, newPassword: fresh });
      window.location.assign(safeNext(next));
    } catch (e) {
      const msg = (e as Error).message;
      setError(/invalid password/i.test(msg) ? (forced ? 'That is not the temporary password' : 'That is not your current password') : msg);
      setBusy(false);
    }
  };

  return (
    <Card className="w-full max-w-[440px]" pad="xl">
      <Kicker>Security · password</Kicker>
      <h2 className="mt-1 mb-1 text-[28px]">{forced ? 'Choose your own password' : 'Change password'}</h2>
      <p className="m-0 mb-4 text-neutral-700 text-[13px]">
        {forced ? 'You signed in with a temporary password. Choose a new one to continue — it replaces the temporary one.' : 'Pick a password only you know.'}
      </p>
      <form
        className="grid gap-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label={forced ? 'Temporary password' : 'Current password'}>
          <Input type="password" autoComplete="current-password" autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label="New password" hint="At least 10 characters, with letters and numbers. Do not use the institute name.">
          <Input type="password" autoComplete="new-password" value={fresh} onChange={(e) => setFresh(e.target.value)} />
        </Field>
        <Field label="New password again" error={error}>
          <Input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} invalid={!!error} />
        </Field>
        <Button type="submit" variant="primary" blueprint className="h-10" loading={busy}>
          Save new password
        </Button>
        {!forced && (
          <a href={safeNext(next)} className="text-[13px] text-neutral-700">
            Cancel
          </a>
        )}
      </form>
    </Card>
  );
}
