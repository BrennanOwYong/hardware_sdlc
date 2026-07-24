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
          <Link href="/">Home</Link>
          <Link href="/inventory">Inventory</Link>
          <Link href="/assemble">Assemble</Link>
          <Link href="/timeline">Timeline</Link>
          <Link href="/coach">Coach</Link>
          <Link href="/check">Can I build?</Link>
          <Link href="/builder">Builder</Link>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
