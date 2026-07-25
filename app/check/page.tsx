"use client";

// "Can I build this?" — one photo of the bench plus one sentence about the
// goal, and Forge answers three questions in order: what is on the desk, does
// any of it help, and what is still missing.

import Link from "next/link";
import { useCallback, useMemo, useRef, useState } from "react";
import type { PartDetection } from "@/lib/types";
import { identifyResponseSchema } from "@/lib/inventory/contract";
import {
  VERDICT_COPY,
  assessResponseSchema,
  type AssessResponse,
} from "@/lib/feasibility/contract";
import { looksElectronic } from "@/lib/feasibility/pure";
import {
  LISTING_IMAGE_BASE,
  SHOP_MANIFEST_URL,
  shopManifestSchema,
  type Listing,
} from "@/lib/plan/contract";
import MaskOverlay from "@/components/MaskOverlay";
import VennPanel from "@/components/VennPanel";
import { countByKind } from "@/lib/gapx/counts";
import { computeVenn } from "@/lib/gapx/venn";

const MAX_EDGE = 1568;
type Stage = "idle" | "looking" | "judging" | "done";

function fitDims(w: number, h: number): { w: number; h: number } {
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  return { w: Math.round(w * scale), h: Math.round(h * scale) };
}

function rasterize(file: File): Promise<{ dataUrl: string; w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const { w, h } = fitDims(img.naturalWidth, img.naturalHeight);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      URL.revokeObjectURL(url);
      if (!ctx) return reject(new Error("canvas unavailable"));
      ctx.drawImage(img, 0, 0, w, h);
      resolve({ dataUrl: canvas.toDataURL("image/jpeg", 0.85), w, h });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("could not read that image"));
    };
    img.src = url;
  });
}

export default function CheckPage() {
  const [goal, setGoal] = useState("");
  const [photo, setPhoto] = useState<string | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number }>({ w: 1, h: 1 });
  const [parts, setParts] = useState<PartDetection[]>([]);
  const [assessment, setAssessment] = useState<AssessResponse | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [listings, setListings] = useState<Listing[]>([]);
  const [shortfallKind, setShortfallKind] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const run = useCallback(
    async (dataUrl: string, theGoal: string) => {
      setError(null);
      setNote(null);
      setAssessment(null);
      setParts([]);
      setStage("looking");
      try {
        const idRes = await fetch("/api/identify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ imageBase64: dataUrl }),
        });
        const idParsed = identifyResponseSchema.safeParse(await idRes.json());
        if (!idParsed.success) throw new Error("identify replied in an odd shape");
        const found = idParsed.data.inventory.parts;
        setParts(found);
        if (idParsed.data.note) setNote(idParsed.data.note);

        setStage("judging");
        const asRes = await fetch("/api/assess", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            goal: theGoal,
            parts: found.map((p) => ({ label: p.label, partType: p.partType })),
          }),
        });
        const asParsed = assessResponseSchema.safeParse(await asRes.json());
        if (!asParsed.success) throw new Error("assessment replied in an odd shape");
        setAssessment(asParsed.data);
        if (asParsed.data.note) setNote(asParsed.data.note);
        setStage("done");

        // Only fetch the shop once we know something is missing.
        if (asParsed.data.missing.length > 0 && listings.length === 0) {
          try {
            const shopRes = await fetch(SHOP_MANIFEST_URL);
            const shop = shopManifestSchema.safeParse(await shopRes.json());
            if (shop.success) setListings(shop.data.listings);
          } catch {
            /* links-only fallback */
          }
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setStage("idle");
      }
    },
    [listings.length],
  );

  const onFile = useCallback(
    async (file: File) => {
      if (!goal.trim()) {
        setError("Say what you want to build first, then add the photo.");
        return;
      }
      try {
        const { dataUrl, w, h } = await rasterize(file);
        setPhoto(dataUrl);
        setDims({ w, h });
        await run(dataUrl, goal.trim());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [goal, run],
  );

  const markedParts = useMemo(
    () => (highlighted ? parts.filter((p) => p.id === highlighted) : []),
    [parts, highlighted],
  );

  // The venn compares the bill of materials against what the camera counted,
  // which is what turns "you need wires" into "you have 3 of the 4 you need".
  const venn = useMemo(() => {
    if (!assessment || assessment.required.length === 0) return null;
    return computeVenn(assessment.required, countByKind(parts));
  }, [assessment, parts]);

  const verdictCopy = assessment ? VERDICT_COPY[assessment.verdict] : null;
  const busy = stage === "looking" || stage === "judging";

  return (
    <>
      <h1>Can I build this?</h1>
      <p className="muted" style={{ marginTop: "-0.5rem" }}>
        Tell Forge what you want to make, photograph your desk, and it will say
        whether those parts can do the job and exactly what is missing.
      </p>

      <div className="card">
        <label
          htmlFor="goal"
          style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.3rem" }}
        >
          What do you want to build?
        </label>
        <input
          id="goal"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="a light that blinks when someone walks past"
          style={{
            width: "100%",
            padding: "0.6rem 0.9rem",
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            color: "var(--text)",
            fontSize: "1rem",
          }}
        />
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onFile(f);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          className="btn btn-primary"
          style={{ marginTop: "0.6rem" }}
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          {stage === "looking"
            ? "Looking at your desk…"
            : stage === "judging"
              ? "Working out what you need…"
              : photo
                ? "Try another photo"
                : "Photograph my desk"}
        </button>
      </div>

      {error ? <div className="banner error">{error}</div> : null}
      {note ? <div className="banner warn">{note}</div> : null}

      {photo ? (
        <div className="card">
          <div style={{ position: "relative" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photo}
              alt="your desk"
              style={{ width: "100%", borderRadius: 8, display: "block" }}
            />
            <MaskOverlay parts={markedParts} width={dims.w} height={dims.h} />
          </div>
          {parts.length > 0 ? (
            <>
              <p className="muted" style={{ fontSize: "0.8rem", margin: "0.5rem 0 0.3rem" }}>
                {parts.length} thing{parts.length === 1 ? "" : "s"} on the desk —
                tap one to light it up
              </p>
              <div style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap" }}>
                {parts.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="badge"
                    onClick={() =>
                      setHighlighted((cur) => (cur === p.id ? null : p.id))
                    }
                    style={{
                      cursor: "pointer",
                      borderColor:
                        highlighted === p.id ? "var(--accent)" : "var(--border)",
                      color: highlighted === p.id ? "var(--accent)" : undefined,
                      opacity: looksElectronic(p.partType, p.label) ? 1 : 0.65,
                    }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {venn ? (
        <VennPanel
          venn={venn}
          selectedKind={shortfallKind}
          onPickShortfall={(row) =>
            setShortfallKind((cur) => (cur === row.kind ? null : row.kind))
          }
        />
      ) : null}

      {assessment && verdictCopy ? (
        <>
          <div
            className="card"
            style={{ borderColor: verdictCopy.color, borderWidth: 2 }}
          >
            <h2 style={{ fontSize: "1.1rem", color: verdictCopy.color, margin: 0 }}>
              {verdictCopy.label}
            </h2>
            <p style={{ marginBottom: 0 }}>{assessment.summary}</p>
          </div>

          {assessment.usable.length > 0 ? (
            <div className="card">
              <h3 style={{ fontSize: "0.9rem", color: "var(--accent)" }}>
                What you have that helps
              </h3>
              <ul style={{ paddingLeft: "1.1rem", margin: 0 }}>
                {assessment.usable.map((u) => (
                  <li key={u.name} style={{ marginBottom: "0.25rem" }}>
                    <strong>{u.name}</strong>{" "}
                    <span className="muted">— {u.role}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {assessment.missing.length > 0 ? (
            <div className="card">
              <h3 style={{ fontSize: "0.9rem", color: "var(--warn)" }}>
                What you still need ({assessment.missing.length})
              </h3>
              {assessment.missing.map((m) => {
                const options = listings.filter(
                  (l) => m.partKey && l.partKey === m.partKey,
                );
                return (
                  <div
                    key={m.name}
                    style={{
                      borderTop: "1px solid var(--border)",
                      paddingTop: "0.6rem",
                      marginTop: "0.6rem",
                    }}
                  >
                    <div style={{ display: "flex", gap: "0.4rem", alignItems: "baseline", flexWrap: "wrap" }}>
                      <strong>{m.name}</strong>
                      {m.qty > 1 ? <span className="muted">×{m.qty}</span> : null}
                      {!m.critical ? (
                        <span className="badge">nice to have</span>
                      ) : null}
                    </div>
                    <p className="muted" style={{ margin: "0.15rem 0 0.4rem" }}>
                      {m.why}
                    </p>
                    {options.length > 0 ? (
                      <div style={{ display: "flex", gap: "0.5rem", overflowX: "auto" }}>
                        {options.slice(0, 2).map((l) => (
                          <a
                            key={l.url}
                            href={l.url}
                            target="_blank"
                            rel="noreferrer"
                            style={{
                              minWidth: 150,
                              border: "1px solid var(--border)",
                              borderRadius: 8,
                              padding: "0.4rem",
                              textDecoration: "none",
                              color: "inherit",
                            }}
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={LISTING_IMAGE_BASE + l.imageFile}
                              alt={l.title}
                              style={{
                                width: "100%",
                                height: 80,
                                objectFit: "contain",
                                background: "#fff",
                                borderRadius: 4,
                              }}
                            />
                            <div style={{ fontSize: "0.72rem", marginTop: "0.25rem" }}>
                              {l.currency} {l.price} · {l.store} ↗
                            </div>
                          </a>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}

          {assessment.unusable.length > 0 ? (
            <details className="card">
              <summary className="muted" style={{ cursor: "pointer", fontSize: "0.85rem" }}>
                Why the rest of the desk does not help ({assessment.unusable.length})
              </summary>
              <ul style={{ paddingLeft: "1.1rem", marginTop: "0.5rem" }}>
                {assessment.unusable.map((u) => (
                  <li key={u.name} className="muted" style={{ marginBottom: "0.2rem" }}>
                    <strong>{u.name}</strong> — {u.why}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          <div className="card">
            <h3 style={{ fontSize: "0.9rem" }}>Next step</h3>
            <p style={{ marginBottom: "0.6rem" }}>{assessment.nextStep}</p>
            {/* One honest onward move. The old buttons pointed at /builder and
                /assemble, which are prototypes rather than shipped features. */}
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <Link className="btn btn-primary" href="/coach">
                Get guided through it
              </Link>
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}
