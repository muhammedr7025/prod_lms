import { TwoFactorForm } from './two-factor-form';

export const metadata = { title: 'Two-factor authentication' };

export default async function TwoFactorPage({ searchParams }: { searchParams: Promise<{ next?: string; setup?: string }> }) {
  const sp = await searchParams;
  return (
    <div className="min-h-screen grid place-items-center p-6 bg-surface">
      <TwoFactorForm next={sp.next ?? '/'} />
    </div>
  );
}
