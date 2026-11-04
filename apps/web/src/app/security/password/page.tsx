import { PasswordForm } from './password-form';

export const metadata = { title: 'Change password' };

export default async function PasswordPage({ searchParams }: { searchParams: Promise<{ next?: string; forced?: string }> }) {
  const sp = await searchParams;
  return (
    <div className="min-h-screen grid place-items-center p-6 bg-surface">
      <PasswordForm next={sp.next ?? '/'} forced={sp.forced === '1'} />
    </div>
  );
}
