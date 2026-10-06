import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  // Next's dev server withholds its scripts from page origins it does not
  // recognise, which silently prevents hydration — forms fall back to native
  // submits and client behaviour disappears. Allow 127.0.0.1 alongside the
  // default localhost so either host hydrates.
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
