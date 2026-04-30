import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Bank statement Excel files are typically a few hundred KB but can grow
    // past the 1 MB default for full-month exports. 10 MB gives generous
    // headroom while still rejecting accidental uploads of giant files.
    serverActions: { bodySizeLimit: "10mb" },
  },
};

export default nextConfig;
