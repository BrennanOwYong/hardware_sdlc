"use client";

// Compact nav badge: polls GET /api/bench every 5s and summarizes the bench in
// one line. Green dot + board name when a device is awake, grey "no board"
// when the CLI sees nothing, muted "bench off" when the CLI is missing.
// Always links to /bench.

import Link from "next/link";
import { useEffect, useState } from "react";
import { benchStatusSchema } from "@/lib/bench/parse";

type ChipState =
  | { kind: "loading" }
  | { kind: "off" }
  | { kind: "no-board" }
  | { kind: "awake"; name: string };

function shortBoardName(name: string): string {
  // "Arduino Uno" -> "Uno"; unknown names pass through, trimmed for the nav.
  const stripped = name.replace(/^Arduino\s+/i, "").trim();
  return stripped.length > 0 ? stripped : name;
}

export default function BenchChip() {
  const [state, setState] = useState<ChipState>({ kind: "loading" });

  useEffect(() => {
    let alive = true;
    const poll = async (): Promise<void> => {
      try {
        const res = await fetch("/api/bench", { cache: "no-store" });
        const parsed = benchStatusSchema.safeParse(await res.json());
        if (!alive || !parsed.success) return;
        const status = parsed.data;
        if (!status.cliAvailable) {
          setState({ kind: "off" });
          return;
        }
        const awake = status.devices.find((d) => d.status === "awake");
        setState(
          awake
            ? { kind: "awake", name: shortBoardName(awake.boardName) }
            : { kind: "no-board" },
        );
      } catch {
        if (alive) setState({ kind: "off" });
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const dot = (color: string): React.ReactNode => (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: 999,
        background: color,
        marginRight: "0.35rem",
        verticalAlign: "baseline",
      }}
    />
  );

  let inner: React.ReactNode;
  if (state.kind === "awake") {
    inner = (
      <>
        {dot("var(--accent)")}
        {state.name} awake
      </>
    );
  } else if (state.kind === "no-board") {
    inner = (
      <>
        {dot("var(--muted)")}
        no board
      </>
    );
  } else {
    inner = <span className="muted">bench off</span>;
  }

  return (
    <Link href="/bench" style={{ marginLeft: "auto" }} aria-label="Bench status">
      <span
        className="badge"
        style={state.kind === "awake" ? { color: "var(--accent)", borderColor: "var(--accent)" } : undefined}
      >
        {inner}
      </span>
    </Link>
  );
}
