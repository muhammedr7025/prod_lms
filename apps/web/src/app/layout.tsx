import type { Metadata, Viewport } from 'next';
import { Barlow, Barlow_Condensed } from 'next/font/google';
import { Providers } from '@/components/providers';
import './globals.css';

const barlow = Barlow({ subsets: ['latin'], weight: ['400', '500', '700'], variable: '--font-barlow', display: 'swap' });
const barlowCondensed = Barlow_Condensed({ subsets: ['latin'], weight: ['400', '600'], variable: '--font-barlow-condensed', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Exatech', template: '%s · Exatech' },
  description: 'Exatech institution management platform — enquiry to completion on one system.',
  applicationName: 'Exatech',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icon.svg', apple: '/icon.svg' },
  appleWebApp: { capable: true, title: 'Exatech', statusBarStyle: 'default' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#4f9d68',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${barlow.variable} ${barlowCondensed.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
