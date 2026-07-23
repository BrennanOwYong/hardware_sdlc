import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin file tracing to this app: a stray pnpm-lock.yaml higher up the
  // Windows mount otherwise makes Next infer the wrong workspace root.
  outputFileTracingRoot: path.join(__dirname),
  // Blue-green slots: tools/promote.sh builds into .next-a/.next-b so a new
  // build never disturbs the running server; unset means the default .next.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
};

export default nextConfig;
