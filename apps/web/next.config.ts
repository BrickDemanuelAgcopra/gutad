import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  transpilePackages: ['@gutad/shared'],
  images: { remotePatterns: [{ protocol: 'https', hostname: '**' }] },
  env: { NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || process.env.PUBLIC_API_URL || 'http://localhost:4000' },
};

export default nextConfig;
