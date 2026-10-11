import { canSee, screenForPath } from '@exatech/contracts';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/shell/app-shell';
import { NoAccess } from '@/components/no-access';
import { getMe } from '@/lib/server';

/**
 * Every authenticated route renders inside the shell. The server resolves
 * the session first: signed out → sign-in, 2FA pending → 2FA, screen not
 * allowed for the active membership → no-access (the API refuses it too).
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { me, error } = await getMe();
  const pathname = (await headers()).get('x-pathname') ?? '/';
  if (!me) {
    if (error?.code === 'TWO_FACTOR_REQUIRED' || error?.code === 'TWO_FACTOR_ENROLLMENT_REQUIRED') redirect(`/security/2fa?next=${encodeURIComponent(pathname)}`);
    if (error?.code === 'API_UNAVAILABLE') throw new Error('The Exatech API is not reachable. Start it with `pnpm dev`.');
    const reason = error?.code === 'SESSION_IDLE' ? 'idle' : error?.code === 'SESSION_EXPIRED' ? 'expired' : 'signin';
    redirect(`/sign-in?reason=${reason}&next=${encodeURIComponent(pathname)}`);
  }
  if (me.needs2faEnrollment) redirect(`/security/2fa?setup=1&next=${encodeURIComponent(pathname)}`);

  const screen = screenForPath(pathname);
  const allowed = !screen || canSee(screen, me.membership.permissions);
  return <AppShell me={me}>{allowed ? children : <NoAccess screenLabel={screen?.label ?? 'This page'} />}</AppShell>;
}
