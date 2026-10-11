import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

/* Read-only access to cursor-agent's on-disk chats.
 *
 * Layout (cursor-agent 2026.x, from the CLI bundle and real chats):
 *   <config>/chats/<md5(cwd)>/<chatId>/store.db   SQLite, WAL mode
 *   <config>/chats/<md5(cwd)>/<chatId>/meta.json  {title?, createdAtMs, updatedAtMs, cwd?, hasConversation}
 * <config> is $CURSOR_CONFIG_DIR, else $XDG_CONFIG_HOME/cursor, else ~/.cursor.
 *
 * store.db has two tables: `meta` (key "0" = hex(JSON) of {agentId, latestRootBlobId, name,
 * mode, createdAt, lastUsedModel, ...}) and `blobs` (id = hex of a content hash, data = bytes).
 * The root blob is a protobuf `ConversationStateStructure`; the fields used here:
 *   1  root_prompt_messages_json  blob ids of AI-SDK style JSON messages (system/user/assistant/tool)
 *   5  token_details              {1 used_tokens, 2 max_tokens}
 *   8  turns                      blob ids of ConversationTurnStructure (the UI timeline)
 *   9  previous_workspace_uris    "file:///abs/path"
 *   13 summary_archives           blob ids of {1 summarized_messages: blob ids}
 * A turn is {1 agent_conversation_turn | 2 shell_conversation_turn}. An agent turn has
 * 1 user_message (blob id of UserMessage {1 text, 2 message_id, 25 started_at_ms}),
 * 2 steps (blob ids of ConversationStep {1 assistant_message {1 text, 2 started, 3 completed}
 * | 2 tool_call (ToolCall oneof, 57 tool_call_id, 59 started_at_ms, 60 completed_at_ms)
 * | 3 thinking_message {1 text, 2 duration_ms, 3 started, 4 completed}}), 7 routed_model_display_name. */

/* ── tiny protobuf wire reader ─────────────────────────────── */

export type PbField = { n: number; v: number | Uint8Array };

/** Decodes one message level; throws on malformed input. */
export function pbFields(b: Uint8Array): PbField[] {
  const out: PbField[] = [];
  let i = 0;
  const varint = () => {
    let r = 0;
    let s = 1;
    for (let k = 0; k < 10; k++) {
      if (i >= b.length) throw new Error("truncated varint");
      const x = b[i++];
      r += (x & 0x7f) * s;
      s *= 128;
      if (!(x & 0x80)) return r;
    }
    throw new Error("bad varint");
  };
  while (i < b.length) {
    const tag = varint();
    const n = Math.floor(tag / 8);
    const w = tag % 8;
    if (n === 0) throw new Error("field 0");
    if (w === 0) out.push({ n, v: varint() });
    else if (w === 2) {
      const len = varint();
      if (i + len > b.length) throw new Error("truncated bytes");
      out.push({ n, v: b.subarray(i, i + len) });
      i += len;
    } else if (w === 1) i += 8;
    else if (w === 5) i += 4;
    else throw new Error(`wire type ${w}`);
  }
  return out;
}

export function pbTry(b: Uint8Array | undefined): PbField[] {
  if (!b) return [];
  try {
    return pbFields(b);
  } catch {
    return [];
  }
}

const utf8 = new TextDecoder();
export const pbBytes = (fs: PbField[], n: number) => {
  const f = fs.find((x) => x.n === n);
  return f && f.v instanceof Uint8Array ? f.v : undefined;
};
export const pbAllBytes = (fs: PbField[], n: number) => fs.filter((x) => x.n === n && x.v instanceof Uint8Array).map((x) => x.v as Uint8Array);
export const pbStr = (fs: PbField[], n: number) => {
  const b = pbBytes(fs, n);
  return b ? utf8.decode(b) : undefined;
};
export const pbNum = (fs: PbField[], n: number) => {
  const f = fs.find((x) => x.n === n);
  return f && typeof f.v === "number" ? f.v : undefined;
};
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/* ── paths ─────────────────────────────────────────────────── */

export function configDir(): string {
  const env = process.env.CURSOR_CONFIG_DIR?.trim();
  if (env) return env;
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return xdg ? path.join(xdg, "cursor") : path.join(os.homedir(), ".cursor");
}

export const chatsDir = () => path.join(configDir(), "chats");

const UUIDISH = /^[A-Za-z0-9._-]{1,128}$/;

/** Every chat folder: <chats>/<workspaceHash>/<chatId>. */
export function chatDirs(): { id: string; dir: string }[] {
  const root = chatsDir();
  const out: { id: string; dir: string }[] = [];
  let hashes: string[];
  try {
    hashes = fs.readdirSync(root);
  } catch {
    return out;
  }
  for (const h of hashes) {
    let ids: string[];
    try {
      ids = fs.readdirSync(path.join(root, h));
    } catch {
      continue;
    }
    for (const id of ids) if (UUIDISH.test(id)) out.push({ id, dir: path.join(root, h, id) });
  }
  return out;
}

const dirCache = new Map<string, string>();

export function findChatDir(id: string): string | null {
  if (!UUIDISH.test(id)) return null;
  const cached = dirCache.get(id);
  if (cached && fs.existsSync(cached)) return cached;
  for (const c of chatDirs()) dirCache.set(c.id, c.dir);
  return dirCache.get(id) ?? null;
}

export type ChatMetaJson = { title?: string; createdAtMs?: number; updatedAtMs?: number; cwd?: string; hasConversation?: boolean };

export function readMetaJson(dir: string): ChatMetaJson | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
    return j && typeof j === "object" ? (j as ChatMetaJson) : null;
  } catch {
    return null;
  }
}

/** Newest modification across the chat's files, and their total size. */
export function chatStat(dir: string): { mtime: number; size: number; exists: boolean } {
  let mtime = 0;
  let size = 0;
  let exists = false;
  for (const f of ["store.db", "store.db-wal", "meta.json"]) {
    try {
      const s = fs.statSync(path.join(dir, f));
      exists = true;
      mtime = Math.max(mtime, s.mtimeMs);
      if (f !== "meta.json") size += s.size;
    } catch {
      /* missing */
    }
  }
  return { mtime, size, exists };
}

/* ── store.db ──────────────────────────────────────────────── */

export type StoreMeta = {
  agentId?: string;
  latestRootBlobId?: string;
  name?: string;
  mode?: string;
  createdAt?: number;
  lastUsedModel?: string;
  isRunEverything?: boolean;
};

/** AI-SDK style message as stored in JSON blobs. */
export type AiPart = { type: string; text?: string; toolCallId?: string; toolName?: string; args?: unknown; result?: unknown; [k: string]: unknown };
export type AiMessage = { role: string; content: string | AiPart[]; id?: string; providerOptions?: Record<string, unknown> };

export type StoreStep =
  | { kind: "text"; text: string; ts: number | null }
  | { kind: "thinking"; text: string; ts: number | null; durationMs: number | null }
  | { kind: "tool"; callId: string; ts: number | null; done: boolean; field: number; tool: Uint8Array }
  | { kind: "unknown" };

export type StoreTurn =
  | { kind: "agent"; userId: string | null; userText: string; ts: number | null; steps: StoreStep[]; model: string | null }
  | { kind: "shell"; command: string; stdout: string; stderr: string; exitCode: number | null };

export type StoreChat = {
  meta: StoreMeta;
  root: string;
  /** JSON messages: summary archives first, then the live prompt (system messages dropped) */
  messages: AiMessage[];
  turns: StoreTurn[];
  tokens: { used: number; max: number } | null;
  workspace: string | null;
};

type Sqlite = typeof import("node:sqlite");

function sqlite(): Sqlite | null {
  try {
    /* getBuiltinModule keeps bundlers from trying to resolve node:sqlite */
    return (process.getBuiltinModule?.("node:sqlite") as Sqlite | undefined) ?? null;
  } catch {
    return null;
  }
}

export function openStore(dir: string): DatabaseSync | null {
  const file = path.join(dir, "store.db");
  if (!fs.existsSync(file)) return null;
  const mod = sqlite();
  if (!mod) throw new Error("node:sqlite is unavailable (needs Node 22.13+).");
  return new mod.DatabaseSync(file, { readOnly: true, timeout: 2000 } as ConstructorParameters<Sqlite["DatabaseSync"]>[1]);
}

function parseMetaValue(value: unknown): StoreMeta {
  if (typeof value !== "string") return {};
  const tryJson = (s: string) => {
    try {
      const j = JSON.parse(s);
      return j && typeof j === "object" ? (j as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const j = (/^[0-9a-f]+$/i.test(value) ? tryJson(Buffer.from(value, "hex").toString("utf8")) : null) ?? tryJson(value) ?? {};
  let root = j.latestRootBlobId as unknown;
  if (root && typeof root === "object" && typeof (root as { hex?: unknown }).hex === "string") root = (root as { hex: string }).hex;
  if (Array.isArray(root)) root = Buffer.from(root as number[]).toString("hex");
  return { ...(j as StoreMeta), latestRootBlobId: typeof root === "string" ? root : undefined };
}

/** Cheap: just the meta row (agentId, root id, name, model). */
export function readStoreMeta(dir: string): StoreMeta | null {
  let db: DatabaseSync | null = null;
  try {
    db = openStore(dir);
    if (!db) return null;
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get("0") as { value?: unknown } | undefined;
    return parseMetaValue(row?.value);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function decodeJson(b: Uint8Array | undefined): AiMessage | null {
  if (!b || b[0] !== 0x7b) return null;
  try {
    const j = JSON.parse(utf8.decode(b));
    return j && typeof j === "object" && typeof j.role === "string" ? (j as AiMessage) : null;
  } catch {
    return null;
  }
}

/** Full read of one chat. Returns null when there's no store or it can't be parsed. */
export function readStore(dir: string): StoreChat | null {
  let db: DatabaseSync | null = null;
  try {
    db = openStore(dir);
    if (!db) return null;
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get("0") as { value?: unknown } | undefined;
    const meta = parseMetaValue(row?.value);
    const blobQ = db.prepare("SELECT data FROM blobs WHERE id = ?");
    const blob = (id: Uint8Array | string | undefined): Uint8Array | undefined => {
      if (!id) return undefined;
      const r = blobQ.get(typeof id === "string" ? id : hex(id)) as { data?: Uint8Array } | undefined;
      return r?.data ? new Uint8Array(r.data) : undefined;
    };
    const rootId = meta.latestRootBlobId;
    const root = pbTry(blob(rootId));
    if (!rootId || !root.length) return { meta, root: rootId ?? "", messages: [], turns: [], tokens: null, workspace: null };

    const messages: AiMessage[] = [];
    for (const a of pbAllBytes(root, 13)) {
      for (const id of pbAllBytes(pbTry(blob(a)), 1)) {
        const m = decodeJson(blob(id));
        if (m && m.role !== "system") messages.push(m);
      }
    }
    for (const id of pbAllBytes(root, 1)) {
      const m = decodeJson(blob(id));
      if (m && m.role !== "system") messages.push(m);
    }

    const turns: StoreTurn[] = [];
    for (const id of pbAllBytes(root, 8)) {
      const t = pbTry(blob(id));
      const agent = pbBytes(t, 1);
      const shell = pbBytes(t, 2);
      if (agent) {
        const a = pbTry(agent);
        const um = pbTry(blob(pbBytes(a, 1)));
        let userText = pbStr(um, 1) ?? "";
        if (!userText) userText = utf8.decode(blob(pbBytes(um, 18)) ?? new Uint8Array());
        const steps: StoreStep[] = pbAllBytes(a, 2).map((sid) => decodeStep(pbTry(blob(sid))));
        turns.push({ kind: "agent", userId: pbStr(um, 2) || pbStr(a, 10) || null, userText, ts: pbNum(um, 25) ?? null, steps, model: pbStr(a, 7) || null });
      } else if (shell) {
        const s = pbTry(shell);
        const out = pbTry(blob(pbBytes(s, 2)));
        turns.push({
          kind: "shell",
          command: pbStr(pbTry(blob(pbBytes(s, 1))), 1) ?? "",
          stdout: pbStr(out, 1) ?? "",
          stderr: pbStr(out, 2) ?? "",
          exitCode: pbNum(out, 3) ?? null,
        });
      }
    }

    const td = pbTry(pbBytes(root, 5));
    const used = pbNum(td, 1);
    const ws = pbAllBytes(root, 9).map((b) => utf8.decode(b));
    const wsUri = ws[ws.length - 1];
    return {
      meta,
      root: rootId,
      messages,
      turns,
      tokens: used !== undefined ? { used, max: pbNum(td, 2) ?? 0 } : null,
      workspace: wsUri ? fileUriToPath(wsUri) : null,
    };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function decodeStep(s: PbField[]): StoreStep {
  const am = pbBytes(s, 1);
  if (am) {
    const f = pbTry(am);
    return { kind: "text", text: pbStr(f, 1) ?? "", ts: pbNum(f, 2) ?? null };
  }
  const tm = pbBytes(s, 3);
  if (tm) {
    const f = pbTry(tm);
    return { kind: "thinking", text: pbStr(f, 1) ?? "", ts: pbNum(f, 3) ?? null, durationMs: pbNum(f, 2) ?? null };
  }
  const tc = pbBytes(s, 2);
  if (tc) {
    const f = pbTry(tc);
    /* the oneof member (1..80); 54 hook contexts and 57 the call id are siblings */
    const which = f.find((x) => x.v instanceof Uint8Array && x.n !== 54 && x.n !== 57);
    return {
      kind: "tool",
      callId: pbStr(f, 57) ?? "",
      ts: pbNum(f, 59) ?? null,
      done: pbNum(f, 60) !== undefined,
      field: which?.n ?? 0,
      tool: (which?.v as Uint8Array) ?? new Uint8Array(),
    };
  }
  return { kind: "unknown" };
}

export function fileUriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return uri.slice(7);
  }
}
