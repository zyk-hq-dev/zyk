import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["@hatchet-dev/typescript-sdk", "esbuild"],
};

export default nextConfig;
