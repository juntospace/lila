import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Bank statement Excel files are typically a few hundred KB but can grow
    // past the 1 MB default for full-month exports. 10 MB gives generous
    // headroom while still rejecting accidental uploads of giant files.
    serverActions: { bodySizeLimit: "10mb" },
  },
  // read-excel-file → unzipper has an optional dynamic require of
  // @aws-sdk/client-s3 (used only when streaming from S3). Turbopack's
  // static analyzer follows it and fails the build. Treating these as native
  // Node externals keeps them out of the bundler and lets `require` resolve
  // them at runtime — the S3 path is never taken in our code.
  serverExternalPackages: ["read-excel-file", "unzipper"],
};

export default nextConfig;
