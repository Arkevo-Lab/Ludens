import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

const appRoot = dirname(fileURLToPath(import.meta.url));
const rawServerUrl = process.env.LUDENS_APP_SERVER_URL?.trim().replace(/\/+$/, "");
const httpTarget = rawServerUrl?.replace(/^ws(s?):\/\//i, "http$1://");

const proxy: Record<string, ProxyOptions> | undefined = httpTarget
  ? {
      "/rpc": { target: httpTarget, ws: true },
      "/media": { target: httpTarget },
      "/health": { target: httpTarget },
      "/api": { target: httpTarget, timeout: 130_000, proxyTimeout: 130_000 },
    }
  : undefined;

export default defineConfig({
  root: appRoot,
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@": appRoot,
    },
  },
  build: {
    outDir: "out",
    emptyOutDir: true,
    target: "es2022",
  },
  ...(proxy ? { server: { proxy } } : {}),
});
