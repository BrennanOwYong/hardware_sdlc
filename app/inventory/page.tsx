"use client";

// Inventory: Ctrl-F for real life. Photo mode identifies a bench photo and
// lights each matched part's EXACT pixels (SAM mask via MaskOverlay; halo
// pins remain the no-mask fallback). Live mode is snap-on-submit: aim the
// camera or a shared screen, type the hunt, submit - Forge freezes that
// frame with a "captured" flash, stops the camera (light off), analyzes the
// frozen shot, and reports "Scan complete: N items found" on it
// (FEEDBACK.md items 2, 3, 9). A rolling MediaRecorder clip from capture
// start plus a composed results PNG auto-save to /api/live-captures
// (FEEDBACK.md item 10). Photo mode also offers a "Practice photos" strip:
// curated real-camera bench shots from data/images/practice/
// (lib/practice/manifest) that run the exact user-photo path. Media/canvas
// shapes verified against MDN: docs/references-liveux.md (this build),
// docs/references-delta-arfind.md, docs/references-practice-modes.md.
// "Your photos" strip: every identified user photo is saved server-side via
// /api/photos with its identification cached, so reuse is one tap and free
// (docs/references-photolib.md).

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import type { Inventory } from "@/lib/types";
import {
  identifyErrorSchema,
  identifyResponseSchema,
} from "@/lib/inventory/contract";
import { matchesQuery } from "@/lib/inventory/markers";
import {
  CLIP_MAX_BYTES,
  clipContainerMime,
  nextLivePhase,
  pickRecorderMime,
  resultsPngLayout,
  scanSummary,
  shouldDropClip,
  stripDataUrlPrefix,
  type ClipContainerMime,
  type LiveCapturePayload,
  type LiveEvent,
  type LivePhase,
  type MaskedPart,
} from "@/lib/inventory/liveflow";
import {
  loadPracticeManifest,
  practiceMediaUrl,
  type PracticeMediaItem,
} from "@/lib/practice/manifest";
import {
  photoFileUrl,
  photoListResponseSchema,
  photoResponseSchema,
  type PhotoMeta,
} from "@/lib/photos/contract";
import MaskOverlay from "@/components/MaskOverlay";

/** Photo mode export cap; vision docs recommend small long edges (docs/references-p1.md). */
const MAX_EDGE = 1568;
/** Live mode frozen-frame width; 1024 keeps identify fast and masks usable. */
const LIVE_CAPTURE_WIDTH = 1024;
/** Frozen shot quality: the user sees and saves this frame, so keep it crisp. */
const LIVE_JPEG_QUALITY = 0.85;
/** How long the "captured" flash stays on the frozen frame. */
const FLASH_MS = 700;

type InventoryMode = "photo" | "live";
type LiveSource = "camera" | "screen";

/** The still grabbed at submit time; every later step works from this. */
interface FrozenFrame {
  dataUrl: string;
  w: number;
  h: number;
}

/** One on-screen results row for the live table (grouped by label). */
interface LiveGroup {
  label: string;
  partType: string;
  quantity: number;
  confidence: number;
  /** True when any part in the group matched the submitted query. */
  matched: boolean;
}

/**
 * Where the current photo came from. "user" photos (camera/file) are saved to
 * the server-side library after identify; "library" photos are already stored
 * and only re-PATCH their cached identification; practice/sample are on disk
 * already and never saved.
 */
type PhotoOrigin = "user" | "practice" | "sample" | "library";

interface StartOptions {
  /** Object URL to revoke once the image has loaded. */
  revoke?: string;
  /** Cached identification: render instantly, skip the identify call. */
  cachedInventory?: Inventory;
  /** Original capture time (library photos keep theirs). */
  capturedAt?: Date;
  /** Library photo id; identify results re-PATCH this photo's cache. */
  libraryId?: string;
}

interface PartGroup {
  label: string;
  partType: string;
  quantity: number;
  confidence: number;
  ids: string[];
}

function fitDims(w: number, h: number): { w: number; h: number } {
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  return { w: Math.round(w * scale), h: Math.round(h * scale) };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("failed to load image"));
    img.src = src;
  });
}

/** Recorded clip Blob -> bare base64 for the live-captures payload. */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("failed to read the recorded clip"));
    reader.onload = () => resolve(stripDataUrlPrefix(String(reader.result)));
    reader.readAsDataURL(blob);
  });
}

function formatClock(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Beginner-readable message for a media-capture failure (names per MDN). */
function friendlyMediaError(err: unknown, source: LiveSource): string {
  const what = source === "camera" ? "the camera" : "your screen";
  const name = err instanceof DOMException ? err.name : null;
  if (name === "NotAllowedError") {
    return `Sharing ${what} was blocked. Tap the button again and choose Allow when the browser asks.`;
  }
  if (name === "NotFoundError") {
    return source === "camera"
      ? "No camera was found on this device."
      : "Nothing was available to share from this screen.";
  }
  if (name === "NotReadableError") {
    return `Another app is using ${what} right now. Close it and try again.`;
  }
  if (name === "InvalidStateError") {
    return "The browser wants you to tap the button yourself to start sharing. Tap it again.";
  }
  return err instanceof Error ? err.message : String(err);
}

export default function InventoryPage() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [mode, setMode] = useState<InventoryMode>("photo");

  // ---- Photo mode state ----
  const [imageTick, setImageTick] = useState(0); // bumps when a new image loads
  const [isSample, setIsSample] = useState(false);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);
  const [renames, setRenames] = useState<Record<string, string>>({});
  const [editingLabel, setEditingLabel] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [photoAt, setPhotoAt] = useState<Date | null>(null);
  const [showNewPhotoBanner, setShowNewPhotoBanner] = useState(false);
  /** Fitted pixel dims of the displayed photo; MaskOverlay's coordinate space. */
  const [photoDims, setPhotoDims] = useState<{ w: number; h: number } | null>(
    null,
  );

  // ---- Your photos (server-side library, lib/photos/store) ----
  const [myPhotos, setMyPhotos] = useState<PhotoMeta[]>([]);
  const [photoLibNote, setPhotoLibNote] = useState<string | null>(null);
  /** Origin of the current photo; decides whether identify saves to the library. */
  const originRef = useRef<PhotoOrigin>("user");
  /** Library id of the current photo once stored; identify re-PATCHes it. */
  const libraryIdRef = useRef<string | null>(null);

  // ---- Practice photos (curated real-camera bench shots) ----
  const [practicePhotos, setPracticePhotos] = useState<PracticeMediaItem[]>([]);
  const [practiceNote, setPracticeNote] = useState<string | null>(null);

  // Load the practice manifest once on mount. A failure hides the strip and
  // leaves a plain note; photo/live modes work regardless.
  useEffect(() => {
    let cancelled = false;
    loadPracticeManifest()
      .then((manifest) => {
        if (!cancelled) setPracticePhotos(manifest.photos);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setPracticeNote(
            `Practice photos unavailable: ${err instanceof Error ? err.message : String(err)}. Your own photos and the sample image still work.`,
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Live mode state (snap-on-submit; state machine in lib/inventory/liveflow) ----
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const liveStreamRef = useRef<MediaStream | null>(null);
  const liveCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recorderMimeRef = useRef<string | null>(null);
  const liveSourceRef = useRef<LiveSource>("camera");
  const livePhaseRef = useRef<LivePhase>("idle");
  const flashTimerRef = useRef<number | null>(null);

  const [livePhase, setLivePhase] = useState<LivePhase>("idle");
  const [liveQuery, setLiveQuery] = useState("");
  const [liveError, setLiveError] = useState<string | null>(null);
  const [liveNote, setLiveNote] = useState<string | null>(null);
  const [frozenFrame, setFrozenFrame] = useState<FrozenFrame | null>(null);
  const [liveParts, setLiveParts] = useState<MaskedPart[]>([]);
  const [liveMatchedIds, setLiveMatchedIds] = useState<Set<string>>(new Set());
  const [liveSelectedLabel, setLiveSelectedLabel] = useState<string | null>(
    null,
  );
  const [liveFound, setLiveFound] = useState<number | null>(null);
  const [analyzedQuery, setAnalyzedQuery] = useState("");
  const [recordingClip, setRecordingClip] = useState(false);
  const [captureFlash, setCaptureFlash] = useState(false);
  const [flashFade, setFlashFade] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);

  useEffect(() => {
    livePhaseRef.current = livePhase;
  }, [livePhase]);

  const advancePhase = useCallback((event: LiveEvent) => {
    setLivePhase((p) => nextLivePhase(p, event));
  }, []);

  const effectiveLabel = useCallback(
    (originalLabel: string) => renames[originalLabel] ?? originalLabel,
    [renames],
  );

  const groups = useMemo<PartGroup[]>(() => {
    if (!inventory) return [];
    const map = new Map<string, PartGroup>();
    for (const p of inventory.parts) {
      const label = effectiveLabel(p.label);
      const g = map.get(label);
      if (g) {
        g.quantity += 1;
        g.confidence = Math.max(g.confidence, p.confidence);
        g.ids.push(p.id);
      } else {
        map.set(label, {
          label,
          partType: p.partType,
          quantity: 1,
          confidence: p.confidence,
          ids: [p.id],
        });
      }
    }
    return [...map.values()];
  }, [inventory, effectiveLabel]);

  const trimmedQuery = query.trim().toLowerCase();

  const visibleGroups = useMemo(
    () =>
      trimmedQuery
        ? groups.filter(
            (g) =>
              g.label.toLowerCase().includes(trimmedQuery) ||
              g.partType.toLowerCase().includes(trimmedQuery),
          )
        : groups,
    [groups, trimmedQuery],
  );

  const highlightIds = useMemo(() => {
    const ids = new Set<string>();
    if (trimmedQuery) {
      for (const g of visibleGroups) for (const id of g.ids) ids.add(id);
    }
    if (selectedLabel) {
      const g = groups.find((x) => x.label === selectedLabel);
      if (g) for (const id of g.ids) ids.add(id);
    }
    return ids;
  }, [groups, visibleGroups, trimmedQuery, selectedLabel]);

  /**
   * Highlighted parts for MaskOverlay: exact pixels when a part carries a SAM
   * maskPng, halo pin fallback otherwise. Labels reflect local renames.
   */
  const highlightedParts = useMemo<MaskedPart[]>(() => {
    if (!inventory) return [];
    return inventory.parts
      .filter((p) => highlightIds.has(p.id))
      .map((p) => ({ ...p, label: effectiveLabel(p.label) }));
  }, [inventory, highlightIds, effectiveLabel]);

  // Redraw the canvas: the plain photo only. Highlights live in MaskOverlay.
  useEffect(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const { w, h } = fitDims(img.naturalWidth, img.naturalHeight);
    canvas.width = w;
    canvas.height = h;
    setPhotoDims({ w, h });
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
  }, [imageTick]);

  /** Reloads the library strip (?full=1 so taps can reuse cached inventories). */
  const refreshPhotos = useCallback(async () => {
    try {
      const res = await fetch("/api/photos?full=1");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw: unknown = await res.json();
      const parsed = photoListResponseSchema.safeParse(raw);
      if (!parsed.success) throw new Error("unexpected /api/photos response shape");
      setMyPhotos(parsed.data.photos);
      setPhotoLibNote(null);
    } catch (e) {
      setPhotoLibNote(
        `Your photo library is unavailable right now: ${e instanceof Error ? e.message : String(e)}.`,
      );
    }
  }, []);

  useEffect(() => {
    void refreshPhotos();
  }, [refreshPhotos]);

  /**
   * Saves the current user photo to the server library and caches its
   * identification. Fire-and-forget: a failure leaves a muted note and the
   * on-screen result keeps working.
   */
  const saveToLibrary = useCallback(
    async (dataUrl: string, w: number, h: number, inv: Inventory) => {
      try {
        let id = libraryIdRef.current;
        if (!id) {
          const res = await fetch("/api/photos", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ photoDataUrl: dataUrl, width: w, height: h }),
          });
          const raw: unknown = await res.json();
          if (!res.ok) {
            const errParse = identifyErrorSchema.safeParse(raw);
            throw new Error(
              errParse.success ? errParse.data.error : `HTTP ${res.status}`,
            );
          }
          const parsed = photoResponseSchema.safeParse(raw);
          if (!parsed.success) {
            throw new Error("unexpected /api/photos response shape");
          }
          id = parsed.data.photo.id;
          libraryIdRef.current = id;
        }
        const patchRes = await fetch(`/api/photos/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ inventory: inv }),
        });
        if (!patchRes.ok) {
          throw new Error(`caching the identification failed (HTTP ${patchRes.status})`);
        }
        await refreshPhotos();
      } catch (e) {
        setPhotoLibNote(
          `Could not save this photo to your library: ${e instanceof Error ? e.message : String(e)}. It still works on this device for now.`,
        );
      }
    },
    [refreshPhotos],
  );

  const identify = useCallback(async (sample: boolean) => {
    const img = imgRef.current;
    if (!img) return;
    setLoading(true);
    setError(null);
    setNote(null);
    setElapsedMs(null);
    const t0 = performance.now();
    try {
      const { w, h } = fitDims(img.naturalWidth, img.naturalHeight);
      const off = document.createElement("canvas");
      off.width = w;
      off.height = h;
      const ctx = off.getContext("2d");
      if (!ctx) throw new Error("canvas 2d context unavailable");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      const dataUrl = off.toDataURL("image/jpeg", 0.85);
      const res = await fetch("/api/identify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageBase64: dataUrl,
          useSample: sample,
          imageWidth: w,
          imageHeight: h,
        }),
      });
      const raw: unknown = await res.json();
      if (!res.ok) {
        const errParse = identifyErrorSchema.safeParse(raw);
        throw new Error(
          errParse.success
            ? errParse.data.error
            : `identify request failed (HTTP ${res.status})`,
        );
      }
      const parsed = identifyResponseSchema.safeParse(raw);
      if (!parsed.success) throw new Error("unexpected /api/identify response shape");
      setInventory(parsed.data.inventory);
      setNote(parsed.data.note ?? null);
      setRenames({});
      setSelectedLabel(null);
      setElapsedMs(Math.round(performance.now() - t0));
      // Save user photos to the library; re-cache on library re-identifies.
      // Practice/sample images are on disk already and stay out of it.
      if (originRef.current === "user" || originRef.current === "library") {
        void saveToLibrary(dataUrl, w, h, parsed.data.inventory);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [saveToLibrary]);

  const startWithImage = useCallback(
    async (src: string, origin: PhotoOrigin, opts?: StartOptions) => {
      setError(null);
      try {
        const img = await loadImage(src);
        imgRef.current = img;
        originRef.current = origin;
        libraryIdRef.current = opts?.libraryId ?? null;
        const sample = origin === "sample";
        setIsSample(sample);
        setInventory(null);
        setNote(null);
        setQuery("");
        setSelectedLabel(null);
        setRenames({});
        setEditingLabel(null);
        setPhotoAt(opts?.capturedAt ?? new Date());
        setShowNewPhotoBanner(true);
        setImageTick((t) => t + 1);
        if (opts?.cachedInventory) {
          // Library photo with a stored identification: instant and free.
          setInventory(opts.cachedInventory);
          setNote("cached identification - press Re-identify for a fresh look");
          setElapsedMs(null);
        } else {
          await identify(sample);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (opts?.revoke) URL.revokeObjectURL(opts.revoke);
      }
    },
    [identify],
  );

  const onFileChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const url = URL.createObjectURL(file);
      void startWithImage(url, "user", { revoke: url });
      e.target.value = "";
    },
    [startWithImage],
  );

  const onUseSample = useCallback(() => {
    void startWithImage("/sample-parts.svg", "sample");
  }, [startWithImage]);

  /** Tap in the "Your photos" strip: reuse the stored photo, cache first. */
  const onLibraryPhoto = useCallback(
    (p: PhotoMeta) => {
      void startWithImage(photoFileUrl(p.id), "library", {
        libraryId: p.id,
        capturedAt: new Date(p.capturedAt),
        ...(p.inventory ? { cachedInventory: p.inventory } : {}),
      });
    },
    [startWithImage],
  );

  const onDeletePhoto = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/photos/${id}`, { method: "DELETE" });
      // A 404 means it is already gone (e.g. evicted); treat as deleted.
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
      if (libraryIdRef.current === id) libraryIdRef.current = null;
      setMyPhotos((prev) => prev.filter((p) => p.id !== id));
    } catch (e) {
      setPhotoLibNote(
        `Could not delete that photo: ${e instanceof Error ? e.message : String(e)}.`,
      );
    }
  }, []);

  const toggleSelect = useCallback((label: string) => {
    setSelectedLabel((cur) => (cur === label ? null : label));
  }, []);

  const startRename = useCallback((g: PartGroup) => {
    setEditingLabel(g.label);
    setEditValue(g.label);
  }, []);

  const commitRename = useCallback(() => {
    if (!inventory || editingLabel === null) {
      setEditingLabel(null);
      return;
    }
    const value = editValue.trim();
    setRenames((prev) => {
      const next = { ...prev };
      for (const p of inventory.parts) {
        const eff = prev[p.label] ?? p.label;
        if (eff !== editingLabel) continue;
        if (value && value !== p.label) next[p.label] = value;
        else delete next[p.label];
      }
      return next;
    });
    setSelectedLabel((cur) =>
      cur === editingLabel && value ? value : cur === editingLabel ? null : cur,
    );
    setEditingLabel(null);
  }, [inventory, editingLabel, editValue]);

  // ---- Live mode: snap-on-submit (FEEDBACK.md items 3, 9, 10) ----

  /** Stops camera/screen tracks only; frozen frame and results stay put. */
  const releaseStream = useCallback(() => {
    const stream = liveStreamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      liveStreamRef.current = null;
    }
    const video = videoRef.current;
    if (video && video.srcObject) video.srcObject = null;
  }, []);

  /**
   * Stops the rolling recorder and resolves with the finished clip Blob (or
   * null when nothing was recorded). MDN: the final dataavailable fires
   * before the stop event, so chunks are complete inside the stop handler.
   */
  const stopRecorder = useCallback((): Promise<Blob | null> => {
    const rec = recorderRef.current;
    recorderRef.current = null;
    setRecordingClip(false);
    const finish = (mime: string | null): Blob | null => {
      const chunks = recordedChunksRef.current;
      recordedChunksRef.current = [];
      return chunks.length > 0
        ? new Blob(chunks, { type: mime ?? "video/webm" })
        : null;
    };
    if (!rec || rec.state === "inactive") {
      return Promise.resolve(finish(recorderMimeRef.current));
    }
    return new Promise((resolve) => {
      rec.addEventListener(
        "stop",
        () => resolve(finish(rec.mimeType || recorderMimeRef.current)),
        { once: true },
      );
      try {
        rec.stop();
      } catch {
        resolve(finish(recorderMimeRef.current));
      }
    });
  }, []);

  /** Full teardown back to idle: recorder, tracks, frozen state, results. */
  const stopLive = useCallback(() => {
    const rec = recorderRef.current;
    recorderRef.current = null;
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop();
      } catch {
        // Already stopping; nothing to salvage on a teardown.
      }
    }
    recordedChunksRef.current = [];
    setRecordingClip(false);
    releaseStream();
    if (flashTimerRef.current !== null) {
      window.clearTimeout(flashTimerRef.current);
      flashTimerRef.current = null;
    }
    setCaptureFlash(false);
    setLivePhase("idle");
    livePhaseRef.current = "idle";
    setFrozenFrame(null);
    setLiveParts([]);
    setLiveMatchedIds(new Set());
    setLiveSelectedLabel(null);
    setLiveFound(null);
    setSaveNote(null);
  }, [releaseStream]);

  const startLive = useCallback(
    async (source: LiveSource) => {
      stopLive();
      setLiveError(null);
      setLiveNote(null);
      setSaveNote(null);
      liveSourceRef.current = source;
      try {
        // navigator.mediaDevices is undefined off HTTPS/localhost (MDN).
        if (typeof navigator === "undefined" || !navigator.mediaDevices) {
          throw new Error(
            "Camera and screen sharing need HTTPS (or localhost). Open the app over a secure address.",
          );
        }
        if (
          source === "screen" &&
          typeof navigator.mediaDevices.getDisplayMedia !== "function"
        ) {
          throw new Error(
            "Screen sharing works in a computer browser, not on a phone. Use Point camera here.",
          );
        }
        const stream =
          source === "screen"
            ? await navigator.mediaDevices.getDisplayMedia({ video: true })
            : await navigator.mediaDevices.getUserMedia({
                video: { facingMode: "environment" },
              });
        liveStreamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          video.muted = true;
          video.playsInline = true;
          await video.play();
        }
        // Browser-side "Stop sharing" while aiming tears down; after a snap
        // the tracks are already ours to stop, so a late ended is ignored.
        stream.getVideoTracks()[0]?.addEventListener("ended", () => {
          if (livePhaseRef.current === "aim") stopLive();
        });
        // Rolling clip from capture start (FEEDBACK.md item 10). mimeType
        // fallback chain per MDN isTypeSupported; no MediaRecorder (or a
        // constructor refusal) skips the clip and keeps everything else.
        recordedChunksRef.current = [];
        if (typeof MediaRecorder !== "undefined") {
          try {
            const mime = pickRecorderMime((t) =>
              MediaRecorder.isTypeSupported(t),
            );
            const rec = mime
              ? new MediaRecorder(stream, { mimeType: mime })
              : new MediaRecorder(stream);
            recorderMimeRef.current = rec.mimeType || mime;
            rec.ondataavailable = (e: BlobEvent) => {
              if (e.data.size > 0) recordedChunksRef.current.push(e.data);
            };
            rec.start(1000);
            recorderRef.current = rec;
            setRecordingClip(true);
          } catch {
            recorderRef.current = null;
            setRecordingClip(false);
          }
        }
        setLivePhase("aim");
        livePhaseRef.current = "aim";
      } catch (e) {
        stopLive();
        setLiveError(friendlyMediaError(e, source));
      }
    },
    [stopLive],
  );

  /** Grabs the current video frame as the frozen still. */
  const grabFrame = useCallback((): FrozenFrame | null => {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || video.videoWidth === 0) return null;
    let canvas = liveCanvasRef.current;
    if (!canvas) {
      canvas = document.createElement("canvas");
      liveCanvasRef.current = canvas;
    }
    const w = Math.min(LIVE_CAPTURE_WIDTH, video.videoWidth);
    const h = Math.max(1, Math.round((video.videoHeight / video.videoWidth) * w));
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, w, h);
    return { dataUrl: canvas.toDataURL("image/jpeg", LIVE_JPEG_QUALITY), w, h };
  }, []);

  /**
   * Composes the results PNG: accent header (query + timestamp), frozen frame,
   * then label/type/confidence rows. Layout math in lib/inventory/liveflow;
   * toDataURL shapes per MDN (docs/references-liveux.md).
   */
  const composeResultsPng = useCallback(
    async (
      frame: FrozenFrame,
      parts: readonly MaskedPart[],
      q: string,
      capturedAt: Date,
    ): Promise<string> => {
      const img = await loadImage(frame.dataUrl);
      const layout = resultsPngLayout(frame.w, frame.h, Math.max(1, parts.length));
      const canvas = document.createElement("canvas");
      canvas.width = layout.width;
      canvas.height = layout.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas 2d context unavailable");
      ctx.fillStyle = "#0b0f14";
      ctx.fillRect(0, 0, layout.width, layout.height);
      ctx.fillStyle = "#22c55e";
      ctx.fillRect(0, 0, layout.width, layout.headerH);
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#06130a";
      ctx.font = "600 18px system-ui, sans-serif";
      ctx.fillText(
        `Find: "${q}" · ${capturedAt.toLocaleString()}`,
        layout.pad,
        layout.headerH / 2,
        layout.width - layout.pad * 2,
      );
      ctx.drawImage(img, 0, layout.frameY, layout.frameW, layout.frameH);
      const labelX = layout.pad;
      const typeX = Math.round(layout.width * 0.55);
      const confX = Math.round(layout.width * 0.85);
      let y = layout.tableY;
      ctx.fillStyle = "#111a24";
      ctx.fillRect(0, y, layout.width, layout.rowH);
      ctx.fillStyle = "#8b98a5";
      ctx.font = "600 13px system-ui, sans-serif";
      ctx.fillText("Label", labelX, y + layout.rowH / 2);
      ctx.fillText("Type", typeX, y + layout.rowH / 2);
      ctx.fillText("Conf.", confX, y + layout.rowH / 2);
      y += layout.rowH;
      ctx.font = "400 13px system-ui, sans-serif";
      if (parts.length === 0) {
        ctx.fillStyle = "#8b98a5";
        ctx.fillText("No items identified in this shot.", labelX, y + layout.rowH / 2);
      } else {
        for (const p of parts) {
          ctx.strokeStyle = "#22303d";
          ctx.beginPath();
          ctx.moveTo(0, y + layout.rowH - 0.5);
          ctx.lineTo(layout.width, y + layout.rowH - 0.5);
          ctx.stroke();
          ctx.fillStyle = "#e6edf3";
          ctx.fillText(p.label, labelX, y + layout.rowH / 2, typeX - labelX - layout.pad);
          ctx.fillText(p.partType, typeX, y + layout.rowH / 2, confX - typeX - layout.pad);
          ctx.fillStyle = "#22c55e";
          ctx.fillText(
            `${Math.round(p.confidence * 100)}%`,
            confX,
            y + layout.rowH / 2,
          );
          y += layout.rowH;
        }
      }
      return canvas.toDataURL("image/png");
    },
    [],
  );

  /**
   * Fire-and-forget save of {clip?, frame, results PNG} to /api/live-captures
   * (storage builder's route; clipMime must be the bare container and travel
   * with clipBase64). Failures land as a muted note, never a block.
   */
  const saveLiveCapture = useCallback(
    async (
      clip: Blob | null,
      frame: FrozenFrame,
      parts: readonly MaskedPart[],
      q: string,
      capturedAt: Date,
    ) => {
      try {
        let clipBase64: string | undefined;
        let clipMime: ClipContainerMime | undefined;
        let clipNote: string | null = null;
        if (clip && clip.size > 0) {
          const container = clipContainerMime(
            clip.type || recorderMimeRef.current,
          );
          if (container === null) {
            clipNote = "clip skipped: unrecognized recording format";
          } else if (shouldDropClip(clip.size)) {
            clipNote = `clip skipped: over ${Math.round(CLIP_MAX_BYTES / (1024 * 1024))} MB`;
          } else {
            clipBase64 = await blobToBase64(clip);
            clipMime = container;
          }
        }
        const resultsPngDataUrl = await composeResultsPng(
          frame,
          parts,
          q,
          capturedAt,
        );
        const payload: LiveCapturePayload = {
          frameDataUrl: frame.dataUrl,
          resultsPngDataUrl,
          query: q,
          capturedAt: capturedAt.toISOString(),
          ...(clipBase64 !== undefined && clipMime !== undefined
            ? { clipBase64, clipMime }
            : {}),
        };
        const res = await fetch("/api/live-captures", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setSaveNote(
          clipNote ? `saved to live-view (${clipNote})` : "saved to live-view",
        );
      } catch (e) {
        setSaveNote(
          `could not save to live-view: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
    [composeResultsPng],
  );

  /**
   * The snap: freeze the frame with a "captured" flash, stop recorder and
   * camera (light off), identify the frozen still with the query, then show
   * "Scan complete" with exact-pixel masks / halo fallbacks on it.
   */
  const onLiveSubmit = useCallback(async () => {
    if (livePhase !== "aim") return;
    const q = liveQuery.trim().slice(0, 100);
    if (!q) return;
    const frame = grabFrame();
    if (!frame) {
      setLiveError(
        "No video frame available yet. Give the camera a second and try again.",
      );
      return;
    }
    setLiveError(null);
    setLiveNote(null);
    setSaveNote(null);
    setLiveParts([]);
    setLiveMatchedIds(new Set());
    setLiveSelectedLabel(null);
    setLiveFound(null);
    setAnalyzedQuery(q);
    setFrozenFrame(frame);
    advancePhase("submit"); // aim -> captured: the view visibly freezes
    setCaptureFlash(true);
    setFlashFade(false);
    flashTimerRef.current = window.setTimeout(() => {
      flashTimerRef.current = null;
      setCaptureFlash(false);
      advancePhase("flashed"); // captured -> analyzing (no-op once done)
    }, FLASH_MS);
    const clip = await stopRecorder();
    releaseStream(); // camera light goes off: the user sees the camera is done
    const capturedAt = new Date();
    try {
      const res = await fetch("/api/identify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageBase64: frame.dataUrl,
          imageWidth: frame.w,
          imageHeight: frame.h,
          query: q,
        }),
      });
      const raw: unknown = await res.json();
      if (!res.ok) {
        const errParse = identifyErrorSchema.safeParse(raw);
        throw new Error(
          errParse.success
            ? errParse.data.error
            : `identify request failed (HTTP ${res.status})`,
        );
      }
      const parsed = identifyResponseSchema.safeParse(raw);
      if (!parsed.success) throw new Error("unexpected /api/identify response shape");
      if (parsed.data.inventory.source === "mock") {
        // Keyless server: mock parts do not match the frozen shot, so no
        // overlays and no save; surface the server's plain-language note.
        setLiveNote(
          parsed.data.note ??
            "Live identify is off without an API key; photo mode with the sample image still works.",
        );
      } else {
        setLiveNote(parsed.data.note ?? null);
        const parts: MaskedPart[] = parsed.data.inventory.parts;
        const matched = new Set(
          parts.filter((p) => matchesQuery(p, q)).map((p) => p.id),
        );
        setLiveParts(parts);
        setLiveMatchedIds(matched);
        setLiveFound(matched.size);
        void saveLiveCapture(clip, frame, parts, q, capturedAt);
      }
    } catch (e) {
      setLiveError(e instanceof Error ? e.message : String(e));
    } finally {
      advancePhase("resolved"); // -> done
    }
  }, [
    livePhase,
    liveQuery,
    grabFrame,
    advancePhase,
    stopRecorder,
    releaseStream,
    saveLiveCapture,
  ]);

  /** Rearms live mode on the last-used source after a snap. */
  const onResume = useCallback(() => {
    setLiveNote(null);
    setLiveError(null);
    void startLive(liveSourceRef.current);
  }, [startLive]);

  /** Live results grouped by label for the on-screen table. */
  const liveGroups = useMemo<LiveGroup[]>(() => {
    const map = new Map<string, LiveGroup>();
    for (const p of liveParts) {
      const matched = liveMatchedIds.has(p.id);
      const g = map.get(p.label);
      if (g) {
        g.quantity += 1;
        g.confidence = Math.max(g.confidence, p.confidence);
        g.matched = g.matched || matched;
      } else {
        map.set(p.label, {
          label: p.label,
          partType: p.partType,
          quantity: 1,
          confidence: p.confidence,
          matched,
        });
      }
    }
    return [...map.values()];
  }, [liveParts, liveMatchedIds]);

  /** Parts lit on the frozen frame: query matches plus any tapped row. */
  const liveOverlayParts = useMemo<MaskedPart[]>(() => {
    if (livePhase !== "done") return [];
    return liveParts.filter(
      (p) =>
        liveMatchedIds.has(p.id) ||
        (liveSelectedLabel !== null && p.label === liveSelectedLabel),
    );
  }, [livePhase, liveParts, liveMatchedIds, liveSelectedLabel]);

  const toggleLiveSelect = useCallback((label: string) => {
    setLiveSelectedLabel((cur) => (cur === label ? null : label));
  }, []);

  // Release camera/screen tracks (and the recorder) on unmount.
  useEffect(() => stopLive, [stopLive]);

  const switchMode = useCallback(
    (next: InventoryMode) => {
      if (next === "photo") stopLive();
      setMode(next);
    },
    [stopLive],
  );

  const hasImage = imageTick > 0;
  const trimmedLiveQuery = liveQuery.trim();
  const liveFrozen =
    livePhase === "captured" || livePhase === "analyzing" || livePhase === "done";

  return (
    <>
      <h1>Inventory — Ctrl-F for real life</h1>

      <div
        style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem" }}
        role="group"
        aria-label="Inventory mode"
      >
        <button
          type="button"
          className={mode === "photo" ? "btn btn-primary" : "btn"}
          aria-pressed={mode === "photo"}
          onClick={() => switchMode("photo")}
        >
          Photo
        </button>
        <button
          type="button"
          className={mode === "live" ? "btn btn-primary" : "btn"}
          aria-pressed={mode === "live"}
          onClick={() => switchMode("live")}
        >
          Live
        </button>
      </div>

      {mode === "live" ? (
        <>
          <div className="card">
            <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void startLive("camera")}
                disabled={livePhase === "captured" || livePhase === "analyzing"}
              >
                Point camera
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => void startLive("screen")}
                disabled={livePhase === "captured" || livePhase === "analyzing"}
              >
                Watch my screen
              </button>
              {livePhase === "done" ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={onResume}
                >
                  Resume camera
                </button>
              ) : null}
              {livePhase !== "idle" ? (
                <button type="button" className="btn" onClick={stopLive}>
                  Stop
                </button>
              ) : null}
            </div>
            <p className="muted" style={{ marginTop: "0.6rem", marginBottom: 0 }}>
              Point your camera at your bench, or share the screen where your
              part pictures live (screen sharing needs a computer). Type what
              you are hunting for and press Snap &amp; find: Forge takes the
              picture for you, turns the camera off, and studies that frozen
              shot - no need to hold steady.
            </p>
          </div>

          {liveError ? <div className="banner error">{liveError}</div> : null}
          {liveNote ? <div className="banner warn">{liveNote}</div> : null}

          <div className="card">
            <form
              onSubmit={(e: FormEvent<HTMLFormElement>) => {
                e.preventDefault();
                void onLiveSubmit();
              }}
              style={{ display: "flex", gap: "0.5rem" }}
            >
              <input
                type="search"
                value={liveQuery}
                onChange={(e) => setLiveQuery(e.target.value)}
                placeholder='What should I find? e.g. "red wire"'
                aria-label="What to find in the live view"
                maxLength={100}
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: "0.6rem 0.9rem",
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  color: "var(--text)",
                  fontSize: "1rem",
                }}
              />
              <button
                type="submit"
                className="btn btn-primary"
                disabled={livePhase !== "aim" || !trimmedLiveQuery}
              >
                Snap &amp; find
              </button>
            </form>
            <div
              style={{
                display: "flex",
                gap: "0.5rem",
                alignItems: "center",
                marginTop: "0.5rem",
                flexWrap: "wrap",
              }}
            >
              {livePhase === "aim" ? (
                <>
                  <span className="badge" style={{ color: "var(--accent)" }}>
                    camera live{recordingClip ? " · recording" : ""}
                  </span>
                  <span className="muted" style={{ fontSize: "0.85rem" }}>
                    {trimmedLiveQuery
                      ? "Press Snap & find (or Enter) to take the picture."
                      : "Type what you are hunting for, then press Snap & find."}
                  </span>
                </>
              ) : null}
              {livePhase === "captured" || livePhase === "analyzing" ? (
                <span className="badge" style={{ color: "var(--accent)" }}>
                  analyzing your shot…
                </span>
              ) : null}
              {livePhase === "done" && liveFound !== null ? (
                <span className="badge" style={{ color: "var(--accent)" }}>
                  {scanSummary(liveFound)}
                </span>
              ) : null}
              {saveNote ? (
                <span className="muted" style={{ fontSize: "0.8rem" }}>
                  {saveNote}
                </span>
              ) : null}
            </div>
          </div>

          <div className="card">
            <div style={{ position: "relative" }}>
              <video
                ref={videoRef}
                muted
                playsInline
                style={{
                  width: "100%",
                  display: liveFrozen ? "none" : "block",
                  borderRadius: 8,
                  background: "#000",
                  minHeight: livePhase === "aim" ? undefined : 180,
                }}
              />
              {frozenFrame && liveFrozen ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element -- the frozen shot is an in-memory data URL */}
                  <img
                    src={frozenFrame.dataUrl}
                    alt={`Frozen shot being searched for "${analyzedQuery}"`}
                    style={{
                      width: "100%",
                      display: "block",
                      borderRadius: 8,
                      background: "#000",
                    }}
                  />
                  <MaskOverlay
                    parts={liveOverlayParts}
                    width={frozenFrame.w}
                    height={frozenFrame.h}
                    visible={livePhase === "done"}
                  />
                  {livePhase === "captured" || livePhase === "analyzing" ? (
                    <span
                      style={{
                        position: "absolute",
                        bottom: 12,
                        left: "50%",
                        transform: "translateX(-50%)",
                        background: "rgba(11, 15, 20, 0.85)",
                        border: "1px solid var(--border)",
                        color: "var(--text)",
                        padding: "0.25rem 0.9rem",
                        borderRadius: 999,
                        fontSize: "0.85rem",
                        whiteSpace: "nowrap",
                      }}
                    >
                      analyzing your shot…
                    </span>
                  ) : null}
                  {captureFlash ? (
                    <>
                      <div
                        aria-hidden="true"
                        style={{
                          position: "absolute",
                          inset: 0,
                          borderRadius: 8,
                          background: "#fff",
                          opacity: flashFade ? 0 : 0.85,
                          transition: "opacity 0.6s ease-out",
                          pointerEvents: "none",
                        }}
                      />
                      <span
                        style={{
                          position: "absolute",
                          top: 12,
                          left: "50%",
                          transform: "translateX(-50%)",
                          background: "var(--accent)",
                          color: "#06130a",
                          fontWeight: 600,
                          padding: "0.25rem 0.9rem",
                          borderRadius: 999,
                          fontSize: "0.85rem",
                        }}
                      >
                        captured
                      </span>
                    </>
                  ) : null}
                </>
              ) : null}
            </div>
            {livePhase === "idle" ? (
              <p className="muted" style={{ margin: "0.6rem 0 0" }}>
                Nothing playing yet. Tap Point camera or Watch my screen to
                start; the browser will ask for permission first.
              </p>
            ) : null}
            {liveFrozen ? (
              <p className="muted" style={{ margin: "0.6rem 0 0", fontSize: "0.85rem" }}>
                Camera stopped - the light is off and this frozen shot is what
                Forge is reading. Resume camera rearms it.
              </p>
            ) : null}
          </div>

          {livePhase === "done" && liveGroups.length > 0 ? (
            <>
              <div className="card" style={{ padding: 0, overflowX: "auto" }}>
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: "0.9rem",
                  }}
                >
                  <thead>
                    <tr>
                      {["Type", "Label", "Conf.", "Qty"].map((head) => (
                        <th
                          key={head}
                          style={{
                            textAlign: "left",
                            padding: "0.55rem 0.75rem",
                            borderBottom: "1px solid var(--border)",
                            color: "var(--muted)",
                            fontWeight: 600,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {head}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {liveGroups.map((g) => {
                      const selected = liveSelectedLabel === g.label;
                      return (
                        <tr
                          key={g.label}
                          onClick={() => toggleLiveSelect(g.label)}
                          style={{
                            cursor: "pointer",
                            background: selected
                              ? "rgba(34, 197, 94, 0.2)"
                              : g.matched
                                ? "rgba(34, 197, 94, 0.1)"
                                : "transparent",
                          }}
                        >
                          <td
                            style={{
                              padding: "0.55rem 0.75rem",
                              borderBottom: "1px solid var(--border)",
                              whiteSpace: "nowrap",
                            }}
                          >
                            <span className="badge">{g.partType}</span>
                          </td>
                          <td
                            style={{
                              padding: "0.55rem 0.75rem",
                              borderBottom: "1px solid var(--border)",
                            }}
                          >
                            {g.label}
                          </td>
                          <td
                            style={{
                              padding: "0.55rem 0.75rem",
                              borderBottom: "1px solid var(--border)",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {Math.round(g.confidence * 100)}%
                          </td>
                          <td
                            style={{
                              padding: "0.55rem 0.75rem",
                              borderBottom: "1px solid var(--border)",
                            }}
                          >
                            {g.quantity}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="muted" style={{ fontSize: "0.85rem" }}>
                Rows matching “{analyzedQuery}” are lit on the frozen shot
                above; tap any other row to light that part too.
              </p>
            </>
          ) : null}
        </>
      ) : (
        <>
          <div className="card">
            <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => fileInputRef.current?.click()}
                disabled={loading}
              >
                Photograph your bench
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                onChange={onFileChange}
                style={{ display: "none" }}
              />
              <button
                type="button"
                className="btn"
                onClick={onUseSample}
                disabled={loading}
              >
                Use sample parts image
              </button>
              {hasImage ? (
                <button
                  type="button"
                  className="btn"
                  onClick={() => void identify(isSample)}
                  disabled={loading}
                >
                  Re-identify
                </button>
              ) : null}
            </div>
            {photoAt ? (
              <p className="muted" style={{ margin: "0.6rem 0 0", fontSize: "0.85rem" }}>
                Bench photo from {formatClock(photoAt)}; retake any time.
              </p>
            ) : null}
            <p className="muted" style={{ marginTop: "0.6rem", marginBottom: 0 }}>
              Snap your parts spread (or a screen with part cutouts) and Forge
              names everything it sees. Then search below to light a part up
              in the photo.
            </p>
          </div>

          {/* Your photos: server-side library (data/images/user via /api/photos).
              A tap reuses the stored photo; a cached identification renders
              instantly with no identify call. */}
          <div className="card">
            <h2 style={{ fontSize: "0.95rem", marginTop: 0 }}>Your photos</h2>
            {myPhotos.length > 0 ? (
              <div
                style={{
                  display: "flex",
                  gap: "0.75rem",
                  overflowX: "auto",
                  paddingBottom: "0.25rem",
                }}
              >
                {myPhotos.map((p) => (
                  <figure
                    key={p.id}
                    style={{
                      margin: 0,
                      flex: "0 0 auto",
                      width: 150,
                      position: "relative",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => onLibraryPhoto(p)}
                      disabled={loading}
                      aria-label={`Reuse photo ${p.label}`}
                      title={p.label}
                      style={{
                        padding: 0,
                        border: "1px solid var(--border)",
                        borderRadius: 6,
                        background: "none",
                        cursor: loading ? "default" : "pointer",
                        display: "block",
                        width: "100%",
                        overflow: "hidden",
                      }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element -- thumbnails stream from /api/photos/<id>/file */}
                      <img
                        src={photoFileUrl(p.id)}
                        alt={p.label}
                        loading="lazy"
                        style={{
                          width: "100%",
                          height: 96,
                          objectFit: "cover",
                          display: "block",
                        }}
                      />
                    </button>
                    <button
                      type="button"
                      onClick={() => void onDeletePhoto(p.id)}
                      aria-label={`Delete ${p.label}`}
                      title="Delete this photo"
                      style={{
                        position: "absolute",
                        top: 4,
                        right: 4,
                        width: 22,
                        height: 22,
                        lineHeight: "20px",
                        padding: 0,
                        border: "1px solid var(--border)",
                        borderRadius: "50%",
                        background: "var(--bg)",
                        color: "var(--text)",
                        fontSize: "0.8rem",
                        cursor: "pointer",
                      }}
                    >
                      ×
                    </button>
                    <figcaption
                      className="muted"
                      style={{ fontSize: "0.7rem", marginTop: 4 }}
                    >
                      {p.label}
                      {p.inventory ? " · identified" : ""}
                    </figcaption>
                  </figure>
                ))}
              </div>
            ) : (
              <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
                Photos you take appear here for one-tap reuse.
              </p>
            )}
            {photoLibNote ? (
              <p
                className="muted"
                style={{ margin: "0.5rem 0 0", fontSize: "0.8rem" }}
              >
                {photoLibNote}
              </p>
            ) : null}
          </div>

          {/* Practice photos: curated real-camera bench shots. A click runs
              the exact user-photo path (startWithImage → new-photo banner →
              identify → exact-pixel highlights → search). */}
          {practicePhotos.length > 0 ? (
            <div className="card">
              <h2 style={{ fontSize: "0.95rem", marginTop: 0 }}>
                Practice photos
              </h2>
              <p
                className="muted"
                style={{ margin: "0.35rem 0 0.6rem", fontSize: "0.85rem" }}
              >
                No hardware on hand? Pick a real workbench photo and Forge
                treats it exactly like one you took.
              </p>
              <div
                style={{
                  display: "flex",
                  gap: "0.75rem",
                  overflowX: "auto",
                  paddingBottom: "0.25rem",
                }}
              >
                {practicePhotos.map((p) => (
                  <figure
                    key={p.file}
                    style={{ margin: 0, flex: "0 0 auto", width: 150 }}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        void startWithImage(practiceMediaUrl(p), "practice")
                      }
                      disabled={loading}
                      aria-label={`Use practice photo: ${p.title}`}
                      title={p.title}
                      style={{
                        padding: 0,
                        border: "1px solid var(--border)",
                        borderRadius: 6,
                        background: "none",
                        cursor: loading ? "default" : "pointer",
                        display: "block",
                        width: "100%",
                        overflow: "hidden",
                      }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element -- thumbnails stream from /api/images/practice/ */}
                      <img
                        src={practiceMediaUrl(p)}
                        alt={p.title}
                        loading="lazy"
                        style={{
                          width: "100%",
                          height: 96,
                          objectFit: "cover",
                          display: "block",
                        }}
                      />
                    </button>
                    <figcaption
                      className="muted"
                      style={{ fontSize: "0.7rem", marginTop: 4 }}
                    >
                      {p.credit} · {p.license}
                    </figcaption>
                  </figure>
                ))}
              </div>
            </div>
          ) : practiceNote ? (
            <div className="card">
              <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
                {practiceNote}
              </p>
            </div>
          ) : null}

          {showNewPhotoBanner && hasImage ? (
            <div
              className="banner"
              style={{
                display: "flex",
                gap: "0.6rem",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <span>
                New photo received. This is my picture of your bench from now
                on - searches now look here.
              </span>
              <button
                type="button"
                className="btn"
                style={{ padding: "0.2rem 0.7rem", fontSize: "0.8rem" }}
                onClick={() => setShowNewPhotoBanner(false)}
              >
                Got it
              </button>
            </div>
          ) : null}

          {error ? <div className="banner error">{error}</div> : null}
          {note ? <div className="banner warn">{note}</div> : null}

          {hasImage ? (
            <div className="card">
              <div
                style={{
                  display: "flex",
                  gap: "0.5rem",
                  alignItems: "center",
                  marginBottom: "0.6rem",
                  flexWrap: "wrap",
                }}
              >
                {inventory ? (
                  <>
                    <span className="badge">
                      source: {inventory.source === "vlm" ? "vision model" : "mock"}
                    </span>
                    <span className="badge">{inventory.parts.length} parts</span>
                    {elapsedMs !== null ? (
                      <span className="badge">{(elapsedMs / 1000).toFixed(1)} s</span>
                    ) : null}
                  </>
                ) : null}
                {loading ? <span className="muted">Identifying parts…</span> : null}
              </div>
              <div style={{ position: "relative" }}>
                <canvas
                  ref={canvasRef}
                  style={{
                    width: "100%",
                    height: "auto",
                    display: "block",
                    borderRadius: 8,
                    border: "1px solid var(--border)",
                    background: "#fff",
                  }}
                />
                <MaskOverlay
                  parts={highlightedParts}
                  width={photoDims?.w ?? 0}
                  height={photoDims?.h ?? 0}
                />
              </div>
            </div>
          ) : null}

          {inventory ? (
            <>
              <div className="card">
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder='Find a part… e.g. "resistor" or "red"'
                  aria-label="Search parts"
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
                {trimmedQuery ? (
                  <p className="muted" style={{ margin: "0.5rem 0 0" }}>
                    {highlightIds.size} match{highlightIds.size === 1 ? "" : "es"}{" "}
                    lit on the photo above.
                  </p>
                ) : null}
              </div>

              <div className="card" style={{ padding: 0, overflowX: "auto" }}>
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: "0.9rem",
                  }}
                >
                  <thead>
                    <tr>
                      {["Type", "Label", "Conf.", "Qty", ""].map((head) => (
                        <th
                          key={head}
                          style={{
                            textAlign: "left",
                            padding: "0.55rem 0.75rem",
                            borderBottom: "1px solid var(--border)",
                            color: "var(--muted)",
                            fontWeight: 600,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {head}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleGroups.length === 0 ? (
                      <tr>
                        <td
                          colSpan={5}
                          className="muted"
                          style={{ padding: "0.75rem" }}
                        >
                          No parts match “{query}”.
                        </td>
                      </tr>
                    ) : (
                      visibleGroups.map((g) => {
                        const selected = selectedLabel === g.label;
                        const editing = editingLabel === g.label;
                        return (
                          <tr
                            key={g.label}
                            onClick={() => toggleSelect(g.label)}
                            style={{
                              cursor: "pointer",
                              background: selected
                                ? "rgba(34, 197, 94, 0.12)"
                                : "transparent",
                            }}
                          >
                            <td
                              style={{
                                padding: "0.55rem 0.75rem",
                                borderBottom: "1px solid var(--border)",
                                whiteSpace: "nowrap",
                              }}
                            >
                              <span className="badge">{g.partType}</span>
                            </td>
                            <td
                              style={{
                                padding: "0.55rem 0.75rem",
                                borderBottom: "1px solid var(--border)",
                              }}
                            >
                              {editing ? (
                                <input
                                  autoFocus
                                  value={editValue}
                                  onChange={(e) => setEditValue(e.target.value)}
                                  onClick={(e) => e.stopPropagation()}
                                  onBlur={commitRename}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") commitRename();
                                    if (e.key === "Escape") setEditingLabel(null);
                                  }}
                                  aria-label={`Rename ${g.label}`}
                                  style={{
                                    width: "100%",
                                    minWidth: 140,
                                    padding: "0.3rem 0.5rem",
                                    background: "var(--bg)",
                                    border: "1px solid var(--accent)",
                                    borderRadius: 6,
                                    color: "var(--text)",
                                    fontSize: "0.9rem",
                                  }}
                                />
                              ) : (
                                g.label
                              )}
                            </td>
                            <td
                              style={{
                                padding: "0.55rem 0.75rem",
                                borderBottom: "1px solid var(--border)",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {Math.round(g.confidence * 100)}%
                            </td>
                            <td
                              style={{
                                padding: "0.55rem 0.75rem",
                                borderBottom: "1px solid var(--border)",
                              }}
                            >
                              {g.quantity}
                            </td>
                            <td
                              style={{
                                padding: "0.55rem 0.75rem",
                                borderBottom: "1px solid var(--border)",
                                whiteSpace: "nowrap",
                              }}
                            >
                              <button
                                type="button"
                                className="btn"
                                style={{
                                  padding: "0.25rem 0.7rem",
                                  fontSize: "0.8rem",
                                }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  startRename(g);
                                }}
                              >
                                Rename
                              </button>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
              <p className="muted" style={{ fontSize: "0.85rem" }}>
                Tap a row to light that part up in the photo (exact pixels when
                a mask exists, a pin otherwise). Rename fixes a wrong label
                locally (two taps: Rename, then Enter).
              </p>
            </>
          ) : !hasImage ? (
            <div className="card">
              <p className="muted" style={{ marginBottom: 0 }}>
                No inventory yet. Take a photo or load the sample parts image to
                start.
              </p>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
