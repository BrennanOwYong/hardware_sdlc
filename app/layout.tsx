import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Forge",
  description: "Vibe coding for hardware: see parts, guide assembly, version builds.",
  manifest: "/manifest.json",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0b0f14",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <nav className="nav">
          <span className="brand">Forge</span>
          {/* Four features, named for what a person does rather than how the
              system is built. Guidance has two halves and both are reachable:
              "Guide" is the bench (the wireframe you build against) and
              "Coach" is the camera (photo of your real desk, annotated).
              /builder and /bench stay reachable by URL as prototypes. */}
          <Link href="/">Home</Link>
          <Link href="/inventory">Find</Link>
          <Link href="/check">Build</Link>
          <Link href="/assemble">Guide</Link>
          <Link href="/coach">Coach</Link>
          <Link href="/timeline">History</Link>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
