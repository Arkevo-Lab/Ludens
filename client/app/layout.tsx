import type { ReactNode } from "react";
import "./globals.css";
import "./pixel-motion.css";
import "@/features/live/activity-feed.css";
import "@/features/live/observation-panel.css";
import "@/features/live/observation-media.css";
import "@/features/live/event-pool-panel.css";
import { LocaleProvider } from "@/lib/locale";

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return <LocaleProvider>{children}</LocaleProvider>;
}
