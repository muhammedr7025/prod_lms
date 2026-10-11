import { RazorpayCheckout } from '@/features/finance';

export const metadata = { title: 'Pay now' };

/** Payment-link target: Razorpay Checkout, or the sandbox checkout when no keys are configured. */
export default async function Page({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  return <RazorpayCheckout orderId={orderId} />;
}
