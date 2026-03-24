import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "pi-gui — A native desktop for AI coding agents",
  description:
    "pi-gui is a macOS desktop app that wraps the pi coding agent in a Codex-style interface. Multi-workspace sessions, real-time agent execution, and persistent history.",
  openGraph: {
    title: "pi-gui — A native desktop for AI coding agents",
    description:
      "A Codex-style desktop interface for AI coding agents. Manage workspaces, run sessions, and review agent work from a native macOS app.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
