import type { NextConfig } from "next";
import { resolve } from "node:path";

const isDev = process.env.LUDENS_NEXT_DEV === "1";
const appServerUrl = process.env.LUDENS_APP_SERVER_URL?.trim().replace(/\/+$/, "");

const config: NextConfig = {
  transpilePackages: ["@ludens/protocol", "@ludens/core"],
  turbopack: { root: resolve(process.cwd(), "..") },
  devIndicators: false,
  ...(isDev
    ? {
        experimental: {
          proxyTimeout: 130_000,
        },
        ...(appServerUrl
          ? {
              rewrites: async () => [
                {
                  source: "/api/:path*",
                  has: [
                    {
                      type: "header",
                      key: "host",
                      value: "^(?:127\\.0\\.0\\.1|localhost|\\[::1\\])(?::\\d+)?$",
                    },
                  ],
                  destination: `${appServerUrl}/api/:path*`,
                },
              ],
            }
          : {}),
      }
    : {
        output: "export",
        images: { unoptimized: true },
      }),
};

export default config;
