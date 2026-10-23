import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // LoanDisk repayments CSV files can exceed 20 MB for full portfolios,
    // and bank statements can also be several MBs.
    // 100 MB allows processing full historical backups without stream truncation.
    serverActions: { bodySizeLimit: "100mb" },
    proxyClientMaxBodySize: "100mb",
  },
};

export default nextConfig;
