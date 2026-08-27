"use client";

// A part name you can click to see the part.
//
// The drawn likeness comes first and the photograph second, on purpose: the
// drawing can point at the leg that matters, and the photo confirms the
// drawing is describing the real object. Photos are Creative Commons, so the
// credit line ships with the image rather than being someone's later problem.

import { useEffect, useRef, useState } from "react";
import { partLook, type PartGlyph, type PartLook } from "@/lib/parts/gallery";

function Glyph({ kind, colour }: { kind: PartGlyph; colour: string }) {
  const common = { width: 120, height: 74, viewBox: "0 0 120 74" } as const;
  if (kind === "led") {
    return (
      <svg {...common} aria-label="LED with a long and a short leg">
        <circle cx={60} cy={26} r={15} fill={colour} opacity={0.85} />
        <rect x={45} y={26} width={30} height={9} fill={colour} opacity={0.85} />
        <line x1={52} y1={35} x2={52} y2={70} stroke="#94a3b8" strokeWidth={3} />
        <line x1={68} y1={35} x2={68} y2={56} stroke="#94a3b8" strokeWidth={3} />
        <text x={44} y={68} fontSize={8} fill="#22c55e" textAnchor="end">long +</text>
        <text x={76} y={54} fontSize={8} fill="#8b98a5">short −</text>
      </svg>
    );
  }
  if (kind === "resistor") {
    return (
      <svg {...common} aria-label="Resistor with colour bands">
        <line x1={6} y1={37} x2={110} y2={37} stroke="#94a3b8" strokeWidth={3} />
        <rect x={34} y={24} width={52} height={26} rx={9} fill="#d6c39a" />
        <rect x={42} y={24} width={6} height={26} fill="#b91c1c" />
        <rect x={54} y={24} width={6} height={26} fill="#b91c1c" />
        <rect x={66} y={24} width={6} height={26} fill="#7c4a1e" />
        <text x={60} y={64} fontSize={8} fill="#8b98a5" textAnchor="middle">
          red · red · brown = 220Ω
        </text>
      </svg>
    );
  }
  if (kind === "button") {
    return (
      <svg {...common} aria-label="Four-legged pushbutton">
        <rect x={38} y={16} width={44} height={40} rx={4} fill="#1f2937" stroke={colour} strokeWidth={2} />
        <circle cx={60} cy={36} r={9} fill={colour} />
        <line x1={38} y1={22} x2={22} y2={22} stroke="#94a3b8" strokeWidth={3} />
        <line x1={38} y1={50} x2={22} y2={50} stroke="#94a3b8" strokeWidth={3} />
        <line x1={82} y1={22} x2={98} y2={22} stroke="#94a3b8" strokeWidth={3} />
        <line x1={82} y1={50} x2={98} y2={50} stroke="#94a3b8" strokeWidth={3} />
        <text x={60} y={70} fontSize={8} fill="#8b98a5" textAnchor="middle">
          legs on one side are joined
        </text>
      </svg>
    );
  }
  if (kind === "wire") {
    return (
      <svg {...common} aria-label="Jumper wire with a pin at each end">
        <path d="M 14 50 Q 60 6 106 50" fill="none" stroke={colour} strokeWidth={5} />
        <rect x={10} y={48} width={8} height={16} fill="#cbd5e1" />
        <rect x={102} y={48} width={8} height={16} fill="#cbd5e1" />
      </svg>
    );
  }
  if (kind === "breadboard") {
    return (
      <svg {...common} aria-label="Breadboard with a channel down the middle">
        <rect x={6} y={10} width={108} height={54} rx={4} fill="#182430" stroke="#22303d" />
        <rect x={10} y={34} width={100} height={6} fill="#0b0f14" />
        {Array.from({ length: 16 }, (_, c) =>
          [16, 22, 28, 46, 52, 58].map((y) => (
            <circle key={`${c}-${y}`} cx={14 + c * 6.2} cy={y} r={1.4} fill="#0b0f14" />
          )),
        )}
        <text x={60} y={72} fontSize={8} fill="#8b98a5" textAnchor="middle">
          the groove breaks the row in two
        </text>
      </svg>
    );
  }
  if (kind === "usb") {
    return (
      <svg {...common} aria-label="USB cable">
        <rect x={8} y={28} width={22} height={16} rx={2} fill="#94a3b8" />
        <path d="M 30 36 Q 60 12 90 36" fill="none" stroke={colour} strokeWidth={5} />
        <rect x={90} y={26} width={20} height={20} rx={2} fill="#cbd5e1" />
        <text x={60} y={64} fontSize={8} fill="#8b98a5" textAnchor="middle">
          flat end to the computer
        </text>
      </svg>
    );
  }
  return (
    <svg {...common} aria-label="Microcontroller board">
      <rect x={10} y={12} width={100} height={50} rx={4} fill="#0f2436" stroke="#22303d" />
      <rect x={2} y={20} width={10} height={14} fill="#94a3b8" />
      {Array.from({ length: 14 }, (_, i) => (
        <rect key={i} x={22 + i * 6} y={14} width={4} height={4} fill="#0b0f14" />
      ))}
      {Array.from({ length: 14 }, (_, i) => (
        <rect key={`b${i}`} x={22 + i * 6} y={56} width={4} height={4} fill="#0b0f14" />
      ))}
      <text x={60} y={42} fontSize={9} fill="#8b98a5" textAnchor="middle">
        pins down both edges
      </text>
    </svg>
  );
}

function Card({ look, onClose }: { look: PartLook; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [onClose]);

  return (
    <div className="fg-part-pop" ref={ref} role="dialog" aria-label={look.name}>
      <div className="fg-part-pop-head">
        <strong>{look.name}</strong>
        <button type="button" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <Glyph kind={look.glyph} colour={look.colour} />
      {look.photo ? (
        <figure className="fg-part-photo">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={look.photo.src} alt={look.photo.title} loading="lazy" />
          <figcaption className="muted">
            {look.photo.credit} · {look.photo.licence}
          </figcaption>
        </figure>
      ) : null}
      <p className="fg-part-line">
        <span className="muted">Spot it: </span>
        {look.recognise}
      </p>
      <p className="fg-part-line">
        <span className="muted">Does: </span>
        {look.does}
      </p>
      {look.watchFor ? (
        <p className="fg-part-line" style={{ color: "var(--warn)" }}>
          Watch for: {look.watchFor}
        </p>
      ) : null}
    </div>
  );
}

export default function PartChip({
  partId,
  children,
}: {
  partId: string;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const look = partLook(partId);
  if (!look) return <>{children}</>;
  return (
    <span className="fg-part-wrap">
      <button
        type="button"
        className="fg-part-chip"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={`What a ${look.name} looks like`}
      >
        <span className="fg-swatch" style={{ background: look.colour }} />
        {children ?? look.name}
      </button>
      {open ? <Card look={look} onClose={() => setOpen(false)} /> : null}
    </span>
  );
}
