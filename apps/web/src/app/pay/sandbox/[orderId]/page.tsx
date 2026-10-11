import { SandboxCheckout } from '@/features/finance';

export const metadata = { title: 'Pay now' };

/** Sandbox checkout (portal session required — the middleware sends signed-out users to sign-in). */
export default async function Page({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  return <SandboxCheckout orderId={orderId} />;
}
