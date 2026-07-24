export type TargetRef = string; // "UNO:D2" | "BB:12:e" | "BB:RAIL:GND" ...
export interface PartDetection { id: string; partType: string; label: string; confidence: number; bbox: [number, number, number, number]; maskPng?: string; } // bbox normalized x,y,w,h in 0..1; maskPng = base64 PNG (no data: prefix), white where the object is, transparent elsewhere
export interface Inventory { parts: PartDetection[]; photoDataUrl?: string; capturedAt: string; source: 'mock' | 'vlm'; }
export interface NetlistEdge { id: string; kind: 'wire' | 'component'; part?: string; value?: string; from: TargetRef; to: TargetRef; }
export interface Netlist { edges: NetlistEdge[]; }
export interface StepTarget { ref: TargetRef; x: number; y: number; } // normalized overlay coords on the board view
export interface AssemblyStep { id: string; index: number; instruction: string; edge: NetlistEdge; targets: StepTarget[]; }
export type StepPhase = 'pending' | 'active' | 'tip-on-target' | 'seated' | 'error';
export type PerceptionEvent =
  | { type: 'detections'; atMs: number; parts: PartDetection[] }
  | { type: 'tip-at'; atMs: number; ref: TargetRef }
  | { type: 'seated'; atMs: number; edgeId: string }
  | { type: 'misplaced'; atMs: number; edgeId: string; expected: TargetRef[]; observed: string };
export interface MockScriptEntry { atMs: number; event: PerceptionEvent; }
export type PerceptionListener = (e: PerceptionEvent) => void;
export interface PerceptionBackend { start(): void; stop(): void; subscribe(l: PerceptionListener): () => void; inject?(e: PerceptionEvent): void; }
export type BackendMode = 'mock' | 'manual' | 'live';
export interface LiveSourceOptions { source: 'camera' | 'screen' | 'file'; intervalMs?: number; fileUrl?: string; }
export interface JournalEntry { id: string; at: string; kind: "coach" | "flash"; summary: string; detail?: string; framePath?: string; goal?: string; attempt?: string; verdict?: string; firmwareHash?: string; } // at = ISO timestamp; framePath is relative to data/images/ and served by GET /api/images/<framePath>
export interface BuildCommit { id: string; parent: string | null; branch: string; message: string; createdAt: string; photoDataUrl?: string; netlist: Netlist; firmware: { code: string; hash: string }; journal?: JournalEntry[]; }
export interface NetlistDiff { added: NetlistEdge[]; removed: NetlistEdge[]; }
export interface CodegenRequest { netlist: Netlist; circuitHint?: 'button-led' | 'dht11'; intent?: string; }
export interface CodegenResult { code: string; hash: string; pinsUsed: string[]; via: 'template' | 'llm'; }
export interface SimulatePanelProps { step: AssemblyStep | null; onInject: (e: PerceptionEvent) => void; }
export interface CodePanelProps { result: CodegenResult | null; loading?: boolean; onTweak?: (intent: string) => void; }

// --- Delta build 2 contracts (bench + AR find) -------------------------------
export type Transport = "usb" | "wifi-ota";
export type DeviceStatus = "awake" | "quiet" | "unplugged";
export interface PeripheralInfo { name: string; pin: string; source: "netlist" | "vision" | "user"; }
export interface DeviceCard { id: string; boardName: string; fqbn: string | null; port: string | null; transport: Transport; status: DeviceStatus; lastSeen: string | null; firmwareHash: string | null; peripherals: PeripheralInfo[]; }
export interface BenchStatus { cliAvailable: boolean; cliPath: string | null; coreInstalled: boolean; devices: DeviceCard[]; note?: string; }
export interface FlashRequest { code: string; deviceId?: string; }
export interface FlashResult { ok: boolean; stage: "compile" | "upload" | "handshake" | "done"; output: string; firmwareHash?: string; guidance?: string; }
export interface ArMarker { x: number; y: number; w?: number; h?: number; label: string; kind: "find" | "board" | "peripheral"; }
export interface ArMarkerLayerProps { markers: ArMarker[]; visible?: boolean; }
