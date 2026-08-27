"use client";

// The editor around the wireframe: what you can drag in, what you are
// holding, and which physical thing each shape on the canvas claims to be.
//
// The device cards matter as much as the drawing. A wireframe that shows 30
// rows is only useful if it also says "drawn as a 400-point half-size
// breadboard, because your photo said 'breadboard' without saying which one".
// Where the model is a guess, the card says guess, and swapping the model
// redraws the board underneath the same wiring.

import { useCallback, useMemo, useRef, useState } from "react";
import type { Netlist, NetlistEdge } from "@/lib/types";
import { CATALOG, specById, type DeviceSpec } from "@/lib/devices/catalog";
import {
  autoPlace,
  describeRef,
  geometryFor,
  instanceBase,
  layoutProject,
  resolveRef,
  specSummary,
  type Placement,
} from "@/lib/devices/layout";
import type { DeviceMatch } from "@/lib/devices/detect";
import Wireframe, { canvasSize, wireColour, type PlacementTool } from "./Wireframe";

const TOOLS: { id: string; name: string; tool: PlacementTool }[] = [
  { id: "w-black", name: "Jumper · black", tool: { kind: "wire", part: "wire-black", colour: wireColour("black") } },
  { id: "w-red", name: "Jumper · red", tool: { kind: "wire", part: "wire-red", colour: wireColour("red") } },
  { id: "w-yellow", name: "Jumper · yellow", tool: { kind: "wire", part: "wire-yellow", colour: wireColour("yellow") } },
  { id: "w-blue", name: "Jumper · blue", tool: { kind: "wire", part: "wire-blue", colour: wireColour("blue") } },
  { id: "led", name: "LED", tool: { kind: "component", part: "LED", value: "red", colour: "#ef4444" } },
  { id: "res", name: "Resistor", tool: { kind: "component", part: "resistor", value: "220Ω", colour: "#f59e0b" } },
  { id: "btn", name: "Pushbutton", tool: { kind: "component", part: "pushbutton", colour: "#22c55e" } },
];

export interface CircuitEditorProps {
  /** Device models to start with, in the order they should stack. */
  initialSpecIds: string[];
  /** How each model was chosen, shown on its card. */
  matches?: readonly DeviceMatch[];
  /** Wiring to draw. Controlled: the page owns it while following steps. */
  netlist: Netlist;
  /** Diff colouring, when showing what a step or commit changes. */
  diffAgainst?: Netlist;
  highlightRefs?: readonly string[];
  ghostEdge?: NetlistEdge | null;
  /** Called whenever free editing changes the wiring. */
  onNetlistChange?: (netlist: Netlist) => void;
  /** Hides the free-edit toggle for pages that only present history. */
  allowFreeEdit?: boolean;
  /** "below" folds the palette under the canvas so the bench gets the width.
   *  The guidance page uses it: the layout is the subject there, and the
   *  instructions live in their own column beside it. */
  railPosition?: "side" | "below";
}

export default function CircuitEditor({
  initialSpecIds,
  matches = [],
  netlist,
  diffAgainst,
  highlightRefs = [],
  ghostEdge = null,
  onNetlistChange,
  allowFreeEdit = true,
  railPosition = "side",
}: CircuitEditorProps) {
  const [placements, setPlacements] = useState<Placement[]>(() =>
    autoPlace(initialSpecIds, specById),
  );
  const [toolId, setToolId] = useState<string>(TOOLS[0]?.id ?? "");
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  // Instances whose model the user corrected by hand. Detection has no claim
  // on those any more, and the card should not keep quoting the photo.
  const [userChosen, setUserChosen] = useState<string[]>([]);
  const [freeEdit, setFreeEdit] = useState(false);
  const [scratch, setScratch] = useState<Netlist>({ edges: [] });
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const layout = useMemo(() => layoutProject(placements, specById), [placements]);
  const tool = TOOLS.find((t) => t.id === toolId)?.tool;
  const shown = freeEdit ? scratch : netlist;

  // Connections the current device set cannot physically hold: a row that does
  // not exist on this model, or a rail on a board that has none. Silently
  // dropping them is how a wireframe starts lying.
  const unbuildable = useMemo(
    () =>
      shown.edges.filter(
        (e) => !resolveRef(layout, e.from) || !resolveRef(layout, e.to),
      ),
    [shown, layout],
  );

  const beginFreeEdit = useCallback(() => {
    setScratch({ edges: netlist.edges.map((e) => ({ ...e })) });
    setFreeEdit(true);
  }, [netlist]);

  const moveDevice = useCallback((instanceId: string, xMm: number, yMm: number) => {
    setPlacements((prev) =>
      prev.map((p) => (p.instanceId === instanceId ? { ...p, xMm, yMm } : p)),
    );
  }, []);

  const addDevice = useCallback(
    (specId: string, xMm: number, yMm: number) => {
      const spec = specById(specId);
      if (!spec) return;
      setPlacements((prev) => {
        const base = instanceBase(spec);
        const taken = prev.filter((p) => p.instanceId.replace(/\d+$/, "") === base).length;
        const instanceId = taken === 0 ? base : `${base}${taken + 1}`;
        const geo = geometryFor(spec, instanceId);
        return [
          ...prev,
          {
            instanceId,
            specId,
            xMm: Math.max(0, xMm - geo.widthMm / 2),
            yMm: Math.max(0, yMm - geo.heightMm / 2),
          },
        ];
      });
    },
    [],
  );

  const swapDevice = useCallback((instanceId: string, specId: string) => {
    setPlacements((prev) =>
      prev.map((p) => (p.instanceId === instanceId ? { ...p, specId } : p)),
    );
    setUserChosen((prev) =>
      prev.includes(instanceId) ? prev : [...prev, instanceId],
    );
  }, []);

  const removeDevice = useCallback((instanceId: string) => {
    setPlacements((prev) => prev.filter((p) => p.instanceId !== instanceId));
  }, []);

  const addEdge = useCallback(
    (from: string, to: string) => {
      if (!freeEdit || !tool) return;
      const edge: NetlistEdge = {
        id: `u${Date.now().toString(36)}`,
        kind: tool.kind,
        part: tool.part,
        from,
        to,
        ...(tool.kind === "component" && tool.value ? { value: tool.value } : {}),
      };
      setScratch((prev) => {
        const next = { edges: [...prev.edges, edge] };
        onNetlistChange?.(next);
        return next;
      });
    },
    [freeEdit, tool, onNetlistChange],
  );

  const removeEdge = useCallback(
    (edgeId: string) => {
      setScratch((prev) => {
        const next = { edges: prev.edges.filter((e) => e.id !== edgeId) };
        onNetlistChange?.(next);
        return next;
      });
      setSelectedEdgeId(null);
    },
    [onNetlistChange],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const specId = e.dataTransfer.getData("text/forge-device");
      if (!specId) return;
      const wrap = wrapRef.current?.querySelector("svg");
      if (!wrap) return;
      const rect = wrap.getBoundingClientRect();
      const { w, h } = canvasSize(layout);
      addDevice(
        specId,
        ((e.clientX - rect.left) / rect.width) * w,
        ((e.clientY - rect.top) / rect.height) * h,
      );
    },
    [addDevice, layout],
  );

  const selectedEdge = shown.edges.find((e) => e.id === selectedEdgeId) ?? null;

  return (
    <div className="fg-editor">
    <div className={`fg-editor-grid${railPosition === "below" ? " is-stacked" : ""}`}>
      <div className="fg-editor-canvas" ref={wrapRef} onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
        <Wireframe
          layout={layout}
          netlist={shown}
          mode={freeEdit ? "edit" : "view"}
          // Moving the board is always allowed; only laying and cutting
          // connections needs edit mode. Rearranging the bench to match the
          // desk in front of you does not change the circuit.
          allowDeviceDrag
          {...(diffAgainst ? { diffAgainst } : {})}
          highlightRefs={highlightRefs}
          ghostEdge={ghostEdge}
          selectedEdgeId={selectedEdgeId}
          {...(tool ? { tool } : {})}
          onMoveDevice={moveDevice}
          onAddEdge={addEdge}
          onSelectEdge={setSelectedEdgeId}
        />

        {/* The bar sits directly under the canvas, never behind a fold: a
            control you cannot find is a control you do not have. */}
        <div className="fg-editor-bar">
          {allowFreeEdit ? (
            <button
              type="button"
              className={freeEdit ? "primary" : ""}
              onClick={() => (freeEdit ? setFreeEdit(false) : beginFreeEdit())}
            >
              {freeEdit ? "✓ Wiring unlocked — click to follow steps again" : "Unlock wiring"}
            </button>
          ) : null}
          {freeEdit ? (
            <span className="muted" style={{ fontSize: "0.75rem" }}>
              Drag hole to hole to lay a connection · click a connection to
              select it
            </span>
          ) : (
            <span className="muted" style={{ fontSize: "0.75rem" }}>
              Drag the board to move it · scroll to zoom
              {allowFreeEdit ? " · unlock wiring to lay your own connections" : ""}
            </span>
          )}
          {selectedEdge && freeEdit ? (
            <button type="button" onClick={() => removeEdge(selectedEdge.id)}>
              Remove {selectedEdge.part ?? "connection"}
            </button>
          ) : null}
        </div>
      </div>

      <RailWrap stacked={railPosition === "below"}>
        <section className="card">
          <h3 className="fg-h3">Parts you can place</h3>
          <div className="fg-tools">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setToolId(t.id)}
                className={`fg-tool${toolId === t.id ? " is-on" : ""}`}
                disabled={!freeEdit}
                title={freeEdit ? t.name : "Switch to Edit this layout first"}
              >
                <span className="fg-swatch" style={{ background: t.tool.colour }} />
                {t.name}
              </button>
            ))}
          </div>
        </section>

        <section className="card">
          <h3 className="fg-h3">Devices in this build</h3>
          {layout.devices.map((d) => {
            const chosen = userChosen.includes(d.placement.instanceId);
            const match = chosen
              ? undefined
              : matches.find((m) => m.specId === d.spec.id);
            const alternatives = CATALOG.filter((s) => s.kind === d.spec.kind);
            return (
              <div key={d.placement.instanceId} className="fg-device-card">
                <div className="fg-device-head">
                  <strong>{d.spec.model}</strong>
                  <code className="fg-instance">{d.placement.instanceId}</code>
                </div>
                <p className="muted fg-device-spec">{specSummary(d.spec)}</p>
                <p className="fg-device-why">
                  {match
                    ? match.why
                    : chosen
                      ? "You set this model, so the drawing follows your bench rather than the photo."
                      : "Added by hand from the palette."}
                  {match && match.basis !== "model-name" ? (
                    <span className="fg-flag"> assumed</span>
                  ) : null}
                </p>
                <div className="fg-device-actions">
                  <label className="muted" style={{ fontSize: "0.72rem" }}>
                    Actual model
                    <select
                      value={d.spec.id}
                      onChange={(e) => swapDevice(d.placement.instanceId, e.target.value)}
                    >
                      {alternatives.map((s: DeviceSpec) => (
                        <option key={s.id} value={s.id}>
                          {s.model}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="button" onClick={() => removeDevice(d.placement.instanceId)}>
                    Remove
                  </button>
                </div>
              </div>
            );
          })}
        </section>

        <section className="card">
          <h3 className="fg-h3">Add a device</h3>
          <p className="muted" style={{ fontSize: "0.72rem", marginTop: 0 }}>
            Drag onto the bench, or click to drop it in the middle.
          </p>
          <div className="fg-tools">
            {CATALOG.map((s) => (
              <button
                key={s.id}
                type="button"
                draggable
                onDragStart={(e) => e.dataTransfer.setData("text/forge-device", s.id)}
                onClick={() => addDevice(s.id, layout.widthMm / 2, layout.heightMm / 2)}
                className="fg-tool"
                title={specSummary(s)}
              >
                {s.model}
              </button>
            ))}
          </div>
        </section>

        {unbuildable.length > 0 ? (
          <section className="card fg-warn">
            <h3 className="fg-h3">Not buildable on these devices</h3>
            <ul className="fg-list">
              {unbuildable.map((e) => (
                <li key={e.id}>
                  {e.part ?? e.kind} {e.from} → {e.to}
                  <span className="muted">
                    {" "}
                    — {resolveRef(layout, e.from) ? e.to : e.from} does not exist on the
                    models above.
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {highlightRefs.length > 0 ? (
          <section className="card">
            <h3 className="fg-h3">This step aims at</h3>
            <ul className="fg-list">
              {highlightRefs.map((ref) => (
                <li key={ref}>
                  <code>{ref}</code> — {describeRef(layout, ref)}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </RailWrap>
    </div>
    </div>
  );
}

/** The palette either sits beside the bench or folds beneath it. Folding it
 *  rather than dropping it keeps every control reachable at any width. */
function RailWrap({ stacked, children }: { stacked: boolean; children: React.ReactNode }) {
  if (!stacked) return <div className="fg-editor-side">{children}</div>;
  return (
    <details className="fg-editor-fold">
      <summary>Bench setup: which models, and parts to place</summary>
      <div className="fg-editor-side is-stacked">{children}</div>
    </details>
  );
}
