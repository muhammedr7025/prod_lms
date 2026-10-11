import { redirect } from 'next/navigation';
import { homePath } from '@/components/shell/nav';
import { getMe } from '@/lib/server';

/** "/" lands on the active membership's home screen. */
export default async function Home() {
  const { me, error } = await getMe();
  if (!me) {
    if (error?.code === 'TWO_FACTOR_REQUIRED' || error?.code === 'TWO_FACTOR_ENROLLMENT_REQUIRED') redirect('/security/2fa');
    redirect('/sign-in');
  }
  if (me.needs2faEnrollment) redirect('/security/2fa?setup=1');
  redirect(homePath(me));
}
