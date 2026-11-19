import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

const appRoot = dirname(fileURLToPath(import.meta.url));
const rawServerUrl = (
  process.env.LUDENS_SERVER_URL?.trim() ||
  process.env.LUDENS_APP_SERVER_URL?.trim()
)?.replace(/\/+$/, "");
const httpTarget = rawServerUrl?.replace(/^ws(s?):\/\//i, "http$1://");

const proxy: Record<string, ProxyOptions> | undefined = httpTarget
  ? {
      "/rpc": { target: httpTarget, ws: true },
      "/media": { target: httpTarget },
      "/health": { target: httpTarget },
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
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.PORT) || 3015,
    ...(proxy ? { proxy } : {}),
  },
});
