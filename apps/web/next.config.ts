import type { NextConfig } from 'next';

const API_URL = process.env.API_URL ?? 'http://localhost:4300';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@exatech/ui'],
  // The browser only ever talks to this origin; /api/* is proxied to the NestJS API.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_URL}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=(self)' },
        ],
      },
    ];
  },
  experimental: {
    optimizePackageImports: ['@exatech/ui'],
  },
};

export default nextConfig;
