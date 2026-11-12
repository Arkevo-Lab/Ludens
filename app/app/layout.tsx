import type { Metadata } from "next";
import "./globals.css";
import "./pixel-motion.css";
import "@/features/live/activity-feed.css";
import "@/features/live/observation-panel.css";
import "@/features/live/observation-media.css";
import "@/features/live/event-pool-panel.css";
import { LocaleProvider } from "@/lib/locale";
export const metadata: Metadata = {
  title: "Ludens Console",
  description: "Frames, activity log and run performance in one local console.",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body><LocaleProvider>{children}</LocaleProvider></body>
    </html>
  );
}
