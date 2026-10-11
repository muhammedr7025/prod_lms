'use client';

import { AUTH_PATHS, coreContract, twoFactorContract } from '@exatech/contracts';
import { Button, Card, CardBody, CardTitle, Field, Input, Kicker } from '@exatech/ui';
import { useEffect, useState } from 'react';
import { ApiError, callApi } from '@/lib/api';

type State = { kind: 'loading' } | { kind: 'verify' } | { kind: 'setup'; secret: string; qrSvg: string } | { kind: 'codes'; codes: string[] } | { kind: 'done' };

function safeNext(next: string) {
  return next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

/** Enrol (scan QR → confirm code → save backup codes) or verify a code for this session. */
export function TwoFactorForm({ next }: { next: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const me = await callApi(coreContract.me, {});
        if (me.user.twoFactorEnabled) {
          // Enabled: this session may still need a code. Try a protected call to find out.
          setState({ kind: 'verify' });
        } else {
          const s = await callApi(twoFactorContract.setup, {});
          setState({ kind: 'setup', secret: s.secret, qrSvg: s.qrSvg });
        }
      } catch (e) {
        if (e instanceof ApiError && e.code === 'TWO_FACTOR_REQUIRED') setState({ kind: 'verify' });
        else if (e instanceof ApiError && (e.status === 401 || e.code === 'UNAUTHENTICATED')) window.location.assign('/sign-in');
        else setError((e as Error).message);
      }
    })();
  }, []);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      if (state.kind === 'setup') {
        const r = await callApi(twoFactorContract.enable, { body: { code } });
        setState({ kind: 'codes', codes: r.backupCodes });
      } else {
        await callApi(twoFactorContract.verify, { body: { code } });
        window.location.assign(safeNext(next));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="w-full max-w-[440px]" pad="xl">
      <Kicker>Security · two-factor authentication</Kicker>
      {state.kind === 'loading' && <CardBody>Loading…</CardBody>}

      {state.kind === 'setup' && (
        <>
          <CardTitle className="text-xl">Set up your authenticator</CardTitle>
          <CardBody>Two-factor authentication is mandatory for your role. Scan the code with Google Authenticator, Microsoft Authenticator or 1Password, then enter the 6-digit code.</CardBody>
          <div className="grid justify-items-center gap-2">
            <div className="w-[180px] h-[180px] border border-divider p-1 bg-white [&_svg]:w-full [&_svg]:h-full" dangerouslySetInnerHTML={{ __html: state.qrSvg }} />
            <div className="text-[11px] text-neutral-600 text-center">
              Can&apos;t scan? Enter this key: <span className="font-mono text-ink break-all">{state.secret}</span>
            </div>
          </div>
        </>
      )}

      {state.kind === 'verify' && (
        <>
          <CardTitle className="text-xl">Enter your code</CardTitle>
          <CardBody>Open your authenticator app and enter the current 6-digit code, or one of your backup codes.</CardBody>
        </>
      )}

      {(state.kind === 'setup' || state.kind === 'verify') && (
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field label="Code" error={error}>
            <Input autoFocus inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.trim())} className="text-lg tracking-[0.25em] text-center min-h-11" maxLength={11} />
          </Field>
          <Button type="submit" variant="primary" blueprint loading={busy} className="h-10">
            {state.kind === 'setup' ? 'Turn on two-factor' : 'Verify'}
          </Button>
          <Button
            variant="ghost"
            className="justify-self-start"
            onClick={async () => {
              await fetch(AUTH_PATHS.signOut, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
              window.location.assign('/sign-in');
            }}
          >
            Sign out
          </Button>
        </form>
      )}

      {state.kind === 'codes' && (
        <>
          <CardTitle className="text-xl">Save your backup codes</CardTitle>
          <CardBody>Each code works once if you lose your phone. Store them somewhere safe — they will not be shown again.</CardBody>
          <div className="grid grid-cols-2 gap-1.5 font-mono text-sm bg-accent-100 p-3">
            {state.codes.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
          <Button variant="primary" blueprint className="h-10" onClick={() => window.location.assign(safeNext(next))}>
            I have saved them — continue
          </Button>
        </>
      )}
      {state.kind === 'loading' && error && <div className="text-[13px] text-ink">{error}</div>}
    </Card>
  );
}
