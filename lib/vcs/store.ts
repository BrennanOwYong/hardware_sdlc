// P3 git-for-hardware: JSON-file commit store. Server-only (node builtins).
// Every write funnels through an in-process promise queue so concurrent API
// calls cannot interleave read-modify-write cycles on data/commits.json.
// Docs relied on: see docs/references-p3.md.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BuildCommit, JournalEntry, Netlist, NetlistEdge } from "../types";

interface StoreFile {
  commits: BuildCommit[];
}

export interface CreateCommitInput {
  message: string;
  netlist: Netlist;
  firmware: { code: string; hash: string };
  photoDataUrl?: string;
  /** Defaults to the head of branch "main" when omitted. */
  parent?: string;
  /** Build-journal entries drained from data/journal/pending.json. */
  journal?: JournalEntry[];
}

export class VcsError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "VcsError";
    this.status = status;
  }
}

export function firmwareHash(code: string): string {
  return createHash("sha256").update(code).digest("hex").slice(0, 12);
}

// --- runtime shape guards (the file on disk is untrusted input) -------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isEdge(v: unknown): v is NetlistEdge {
  if (!isRecord(v)) return false;
  return (
    typeof v.id === "string" &&
    (v.kind === "wire" || v.kind === "component") &&
    (v.part === undefined || typeof v.part === "string") &&
    (v.value === undefined || typeof v.value === "string") &&
    typeof v.from === "string" &&
    typeof v.to === "string"
  );
}

function isNetlist(v: unknown): v is Netlist {
  return isRecord(v) && Array.isArray(v.edges) && v.edges.every(isEdge);
}

function optionalString(v: unknown): v is string | undefined {
  return v === undefined || typeof v === "string";
}

function isJournalEntry(v: unknown): v is JournalEntry {
  if (!isRecord(v)) return false;
  return (
    typeof v.id === "string" &&
    typeof v.at === "string" &&
    (v.kind === "coach" || v.kind === "flash") &&
    typeof v.summary === "string" &&
    optionalString(v.detail) &&
    optionalString(v.framePath) &&
    optionalString(v.goal) &&
    optionalString(v.attempt) &&
    optionalString(v.verdict) &&
    optionalString(v.firmwareHash)
  );
}

function isCommit(v: unknown): v is BuildCommit {
  if (!isRecord(v)) return false;
  const firmware = v.firmware;
  return (
    typeof v.id === "string" &&
    (v.parent === null || typeof v.parent === "string") &&
    typeof v.branch === "string" &&
    typeof v.message === "string" &&
    typeof v.createdAt === "string" &&
    (v.photoDataUrl === undefined || typeof v.photoDataUrl === "string") &&
    isNetlist(v.netlist) &&
    isRecord(firmware) &&
    typeof firmware.code === "string" &&
    typeof firmware.hash === "string" &&
    // Pre-journal commits carry no journal field and stay valid.
    (v.journal === undefined ||
      (Array.isArray(v.journal) && v.journal.every(isJournalEntry)))
  );
}

function isStoreFile(v: unknown): v is StoreFile {
  return isRecord(v) && Array.isArray(v.commits) && v.commits.every(isCommit);
}

// --- seeding -----------------------------------------------------------------

const ROOT_FIRMWARE_CODE =
  "// Forge: empty board, nothing to flash yet\nvoid setup() {}\nvoid loop() {}\n";

function rootCommit(): BuildCommit {
  return {
    id: randomUUID(),
    parent: null,
    branch: "main",
    message: "empty board",
    createdAt: new Date().toISOString(),
    netlist: { edges: [] },
    firmware: { code: ROOT_FIRMWARE_CODE, hash: firmwareHash(ROOT_FIRMWARE_CODE) },
  };
}

function lastOnBranch(commits: BuildCommit[], branch: string): BuildCommit | undefined {
  for (let i = commits.length - 1; i >= 0; i -= 1) {
    const c = commits[i];
    if (c && c.branch === branch) {
      return c;
    }
  }
  return undefined;
}

// --- store -------------------------------------------------------------------

export class CommitStore {
  private readonly filePath: string;

  /** Serializes every operation; each link swallows the previous rejection. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Reads the file; seeds it with the "empty board" root commit on first use. */
  private async load(): Promise<StoreFile> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (isStoreFile(parsed) && parsed.commits.length > 0) {
        return parsed;
      }
    } catch {
      // Missing or unparseable file: fall through and seed.
    }
    const seeded: StoreFile = { commits: [rootCommit()] };
    await this.save(seeded);
    return seeded;
  }

  private async save(file: StoreFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(file, null, 2), "utf8");
  }

  /** All commits in creation order (oldest first). */
  list(): Promise<BuildCommit[]> {
    return this.enqueue(async () => (await this.load()).commits);
  }

  get(id: string): Promise<BuildCommit | undefined> {
    return this.enqueue(async () => (await this.load()).commits.find((c) => c.id === id));
  }

  headOf(branch: string): Promise<BuildCommit | undefined> {
    return this.enqueue(async () => lastOnBranch((await this.load()).commits, branch));
  }

  create(input: CreateCommitInput): Promise<BuildCommit> {
    return this.enqueue(async () => {
      const file = await this.load();
      let parent: BuildCommit | undefined;
      if (input.parent !== undefined) {
        parent = file.commits.find((c) => c.id === input.parent);
        if (!parent) {
          throw new VcsError(`parent commit ${input.parent} not found`, 404);
        }
      } else {
        parent = lastOnBranch(file.commits, "main");
        if (!parent) {
          throw new VcsError('branch "main" has no head', 500);
        }
      }
      const commit: BuildCommit = {
        id: randomUUID(),
        parent: parent.id,
        branch: parent.branch,
        message: input.message,
        createdAt: new Date().toISOString(),
        netlist: input.netlist,
        firmware: input.firmware,
        ...(input.photoDataUrl !== undefined ? { photoDataUrl: input.photoDataUrl } : {}),
        ...(input.journal !== undefined && input.journal.length > 0
          ? { journal: input.journal }
          : {}),
      };
      file.commits.push(commit);
      await this.save(file);
      return commit;
    });
  }

  /**
   * Forks a new branch off an existing commit: copies its board state into a
   * new commit whose parent is the source and whose branch is the new label.
   */
  fork(fromId: string, branch: string): Promise<BuildCommit> {
    return this.enqueue(async () => {
      const file = await this.load();
      const from = file.commits.find((c) => c.id === fromId);
      if (!from) {
        throw new VcsError(`commit ${fromId} not found`, 404);
      }
      if (file.commits.some((c) => c.branch === branch)) {
        throw new VcsError(`branch "${branch}" already exists`, 409);
      }
      const commit: BuildCommit = {
        id: randomUUID(),
        parent: from.id,
        branch,
        message: `fork "${branch}" from ${from.id.slice(0, 8)} (${from.message})`,
        createdAt: new Date().toISOString(),
        netlist: from.netlist,
        firmware: from.firmware,
        ...(from.photoDataUrl !== undefined ? { photoDataUrl: from.photoDataUrl } : {}),
      };
      file.commits.push(commit);
      await this.save(file);
      return commit;
    });
  }
}

// Default store used by the API routes. Next.js dev hot-reload can create a
// fresh module instance (and thus a fresh queue); acceptable for the MVP
// because each operation re-reads the file before writing.
let defaultStore: CommitStore | undefined;

export function getStore(): CommitStore {
  if (!defaultStore) {
    defaultStore = new CommitStore(join(process.cwd(), "data", "commits.json"));
  }
  return defaultStore;
}
