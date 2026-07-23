"use client";

// Canvas overlay for live modes: absolutely positioned over a <video>
// element, drawing the same visual states as BoardView at normalized
// coordinates (StepTarget x/y in 0..1 map to the video's rendered size).
// The parent container must be position:relative with the <video> filling it.
//
// Backing store is sized with devicePixelRatio for crisp lines on phones
// (pattern verified against MDN, see docs/references-p2.md).

import { useEffect, useRef } from "react";
import type { AssemblyStep, StepPhase } from "@/lib/types";

const ACCENT = "#22c55e";
const WARN = "#f59e0b";
const ERROR = "#ef4444";
const MUTED = "#8b98a5";

export interface OverlayProps {
  step: AssemblyStep | null;
  phase: StepPhase;
  /** Steps already confirmed seated, drawn as solid green connections. */
  seatedSteps: AssemblyStep[];
}

interface DrawProps {
  step: AssemblyStep | null;
  phase: StepPhase;
  seatedSteps: AssemblyStep[];
}

function drawEdge(
  ctx: CanvasRenderingContext2D,
  step: AssemblyStep,
  w: number,
  h: number,
  color: string,
  dashed: boolean,
): void {
  const a = step.targets[0];
  const b = step.targets[1];
  if (!a || !b) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = dashed ? 3 : 5;
  ctx.lineCap = "round";
  ctx.setLineDash(dashed ? [10, 7] : []);
  ctx.beginPath();
  ctx.moveTo(a.x * w, a.y * h);
  ctx.lineTo(b.x * w, b.y * h);
  ctx.stroke();
  ctx.restore();
}

function drawRing(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
  fill: boolean,
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.stroke();
  if (fill) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export default function Overlay({ step, phase, seatedSteps }: OverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const propsRef = useRef<DrawProps>({ step, phase, seatedSteps });
  propsRef.current = { step, phase, seatedSteps };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const dpr = window.devicePixelRatio || 1;
      const bw = Math.floor(rect.width * dpr);
      const bh = Math.floor(rect.height * dpr);
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);

      const { step: cur, phase: ph, seatedSteps: done } = propsRef.current;
      const w = rect.width;
      const h = rect.height;

      for (const s of done) {
        drawEdge(ctx, s, w, h, ACCENT, false);
        for (const tgt of s.targets) {
          ctx.fillStyle = ACCENT;
          ctx.beginPath();
          ctx.arc(tgt.x * w, tgt.y * h, 6, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      if (cur && ph !== "seated") {
        const ringColor =
          ph === "error" ? ERROR : ph === "tip-on-target" ? ACCENT : WARN;
        const ghostColor =
          ph === "error" ? ERROR : ph === "tip-on-target" ? ACCENT : MUTED;
        drawEdge(ctx, cur, w, h, ghostColor, true);
        const speed = ph === "tip-on-target" ? 180 : 340;
        const radius = 12 + 5 * Math.abs(Math.sin(t / speed));
        for (const tgt of cur.targets) {
          drawRing(
            ctx,
            tgt.x * w,
            tgt.y * h,
            radius,
            ringColor,
            ph === "tip-on-target",
          );
        }
      }
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
      }}
    />
  );
}
