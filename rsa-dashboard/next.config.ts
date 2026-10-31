import type { NextConfig } from "next";
import { resolve } from "node:path";
const config: NextConfig = {
  transpilePackages: ["@ludens/protocol"],
  turbopack: { root: resolve(process.cwd(), "..") },
  devIndicators: false,
};
export default config;
