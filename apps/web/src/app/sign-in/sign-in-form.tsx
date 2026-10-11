'use client';

import { AUTH_PATHS, devContract } from '@exatech/contracts';
import { normalizePhone, isValidEmail } from '@exatech/domain';
import { Button, Field, Icon, Input, Kicker, Seg } from '@exatech/ui';
import { useEffect, useState } from 'react';
import { authPost, callApi } from '@/lib/api';

type Mode = 'email' | 'phone';
type Step = 'enter' | 'sent' | 'code';

const REASONS: Record<string, string> = {
  idle: 'You were signed out after 30 minutes of inactivity.',
  expired: 'Your session expired. Please sign in again.',
};

function safeNext(next: string): string {
  return next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

export function SignInForm({ next, reason, googleEnabled, demoMode, apiDown }: { next: string; reason: string | null; googleEnabled: boolean; demoMode: boolean; apiDown: boolean }) {
  const [mode, setMode] = useState<Mode>('email');
  const [step, setStep] = useState<Step>('enter');
  const [value, setValue] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [accounts, setAccounts] = useState<{ email: string; label: string; name: string; scope: string }[]>([]);
  const target = safeNext(next);

  useEffect(() => {
    if (demoMode) callApi(devContract.accounts, {}).then(setAccounts).catch(() => setAccounts([]));
  }, [demoMode]);

  const send = async () => {
    setError(null);
    if (mode === 'email') {
      if (!isValidEmail(value)) return setError('Enter the email address your institute registered');
      setBusy(true);
      try {
        await authPost(AUTH_PATHS.magicLink, { email: value.trim().toLowerCase(), callbackURL: target, errorCallbackURL: '/sign-in?error=link' });
        setStep('sent');
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    } else {
      const phone = normalizePhone(value);
      if (!phone) return setError('Enter a valid 10-digit mobile number');
      setBusy(true);
      try {
        await authPost(AUTH_PATHS.sendOtp, { phoneNumber: phone });
        setValue(phone);
        setStep('code');
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    }
  };

  const verify = async () => {
    setError(null);
    if (!/^\d{6}$/.test(code)) return setError('Enter the 6-digit code');
    setBusy(true);
    try {
      await authPost(AUTH_PATHS.verifyOtp, { phoneNumber: value, code });
      window.location.assign(target);
    } catch (e) {
      setError((e as Error).message === 'Invalid OTP' ? 'That code is not right — check and try again' : (e as Error).message);
      setBusy(false);
    }
  };

  const demo = async (email: string) => {
    setBusy(true);
    try {
      await authPost(AUTH_PATHS.demoLogin, { email });
      window.location.assign('/');
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="w-full max-w-[400px] grid gap-[18px]">
      <div>
        <Kicker>Sign in</Kicker>
        <h2 className="mt-1 mb-1 text-[32px]">Welcome back</h2>
        <p className="m-0 text-neutral-700 text-[13px]">Accounts are invite-only — created at admission or by staff invite.</p>
      </div>
      {apiDown && <div className="border border-ink px-3 py-2 text-[13px]">The Exatech API is not reachable. Start it, then reload this page.</div>}
      {reason && REASONS[reason] && <div className="border border-divider bg-accent-100 px-3 py-2 text-[13px]">{REASONS[reason]}</div>}

      {step === 'enter' && (
        <>
          <Button
            variant="secondary"
            block
            className="m-0 h-10 justify-center"
            disabled={!googleEnabled || busy}
            title={googleEnabled ? undefined : 'Google sign-in is not configured for this institution'}
            onClick={async () => {
              const res = await authPost<{ url?: string }>(AUTH_PATHS.google, { provider: 'google', callbackURL: target, errorCallbackURL: '/sign-in?error=google' }).catch((e: Error) => {
                setError(e.message);
                return null;
              });
              if (res?.url) window.location.assign(res.url);
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M21 12a9 9 0 1 1-6.2-8.56M21 12h-9" />
            </svg>
            Continue with Google
          </Button>
          <div className="flex items-center gap-2.5 text-neutral-500 text-xs">
            <div className="flex-1 h-px bg-divider" />
            or
            <div className="flex-1 h-px bg-divider" />
          </div>
          <Seg
            full
            value={mode}
            onChange={(m) => {
              setMode(m);
              setError(null);
              setValue('');
            }}
            options={[
              { value: 'email', label: 'Email magic link' },
              { value: 'phone', label: 'Phone OTP' },
            ]}
          />
          <form
            className="grid gap-[18px]"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <Field label={mode === 'email' ? 'Email' : 'Phone'} error={error}>
              <Input
                autoFocus
                inputMode={mode === 'email' ? 'email' : 'tel'}
                autoComplete={mode === 'email' ? 'email' : 'tel'}
                placeholder={mode === 'email' ? 'you@example.com' : '+91 98••• ••210'}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                invalid={!!error}
              />
            </Field>
            <Button type="submit" variant="primary" blueprint className="h-10" loading={busy}>
              {mode === 'email' ? 'Send sign-in link' : 'Send code'}
            </Button>
          </form>
        </>
      )}

      {step === 'sent' && (
        <div className="relative border border-divider p-4 grid gap-2 bg-white">
          <i className="corner tl" />
          <i className="corner tr" />
          <i className="corner bl" />
          <i className="corner br" />
          <div className="flex items-center gap-2">
            <Icon name="mail" />
            <b className="font-heading font-semibold text-[17px]">Check your email</b>
          </div>
          <p className="m-0 text-[13px] text-neutral-700">If {value} has an Exatech account, a sign-in link is on its way. It works once and expires in 15 minutes.</p>
          <Button variant="ghost" className="justify-self-start" onClick={() => setStep('enter')}>
            Use a different address
          </Button>
        </div>
      )}

      {step === 'code' && (
        <form
          className="grid gap-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            void verify();
          }}
        >
          <p className="m-0 text-[13px] text-neutral-700">We sent a 6-digit code to {value} on WhatsApp (SMS if WhatsApp is unavailable). It expires in 5 minutes.</p>
          <Field label="Code" error={error}>
            <Input autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className="text-lg tracking-[0.3em] text-center min-h-11" />
          </Field>
          <Button type="submit" variant="primary" blueprint className="h-10" loading={busy}>
            Verify &amp; sign in
          </Button>
          <Button variant="ghost" className="justify-self-start" onClick={() => setStep('enter')}>
            Change number
          </Button>
        </form>
      )}

      {demoMode && accounts.length > 0 && (
        <div className="border-t border-divider pt-4 grid gap-2">
          <Kicker>Demo · open as</Kicker>
          <div className="grid grid-cols-2 gap-1.5">
            {accounts.map((a) => (
              <button
                key={a.email}
                type="button"
                disabled={busy}
                onClick={() => demo(a.email)}
                title={`${a.name} · ${a.scope}`}
                className="relative text-left px-2.5 py-2 border border-divider bg-transparent text-[13px] font-medium cursor-pointer hover:bg-accent-100 hover:border-accent disabled:opacity-50"
              >
                {a.label}
              </button>
            ))}
          </div>
          <div className="text-[11px] text-neutral-500">Demo mode is on — personas sign in without a code. Never enabled in production.</div>
        </div>
      )}
    </div>
  );
}
