import type { NextConfig } from 'next';
const config: NextConfig = {
  agentRules: false,
  output: 'standalone',
  transpilePackages: ['@zhiyun/cloud-ui', '@zhiyun/cloud-client', '@zhiyun/cloud-contracts'],
  poweredByHeader: false,
};
export default config;
