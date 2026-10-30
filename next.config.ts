import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  ...(process.env.ZAOSHI_BUILD_TARGET === "cvm"
    ? { output: "standalone" as const }
    : {}),
};

export default nextConfig;
