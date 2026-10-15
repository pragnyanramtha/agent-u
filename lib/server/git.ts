import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/* Git for a session's folder: checkpoints of the working tree before each turn (hidden refs, made through a
 * throwaway index so HEAD, the branch and the staging area are never touched), rewinding to one, the branch's
 * status, commit, push, pull requests, and a worktree per session. */

export class GitError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/* checkpoint commits need an author even where git has no user configured */
const BOT = { GIT_AUTHOR_NAME: "agent-u", GIT_AUTHOR_EMAIL: "agent-u@localhost", GIT_COMMITTER_NAME: "agent-u", GIT_COMMITTER_EMAIL: "agent-u@localhost" };

function git(cwd: string, args: string[], opts: { env?: Record<string, string>; timeout?: number; bin?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      opts.bin ?? "git",
      args,
      { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", ...opts.env }, timeout: opts.timeout ?? 20_000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const msg = (stderr.trim() ? stderr : stdout.trim() ? stdout : err.message).trim().split("\n").filter(Boolean).slice(-3).join(" ");
        reject(new GitError(msg || `${opts.bin ?? "git"} ${args[0]} failed`));
      },
    );
  });
}

export async function repoRoot(cwd: string): Promise<string | null> {
  if (!path.isAbsolute(cwd)) return null;
  return git(cwd, ["rev-parse", "--show-toplevel"], { timeout: 5000 })
    .then((s) => s.trim() || null)
    .catch(() => null);
}

async function needRoot(cwd: string) {
  const root = await repoRoot(cwd);
  if (!root) throw new GitError(`${cwd} isn't in a git repository.`, 404);
  return root;
}

/* ── checkpoints ─────────────────────────────────────── */

const MAX_CHECKPOINTS = 60;
export const refBase = (session: string) => `refs/agent-u/cp/${crypto.createHash("sha1").update(session).digest("hex").slice(0, 16)}`;

export type Checkpoint = { id: string; commit: string; tree: string; at: number; label: string };

/** the working tree as git would commit it right now (ignored files left out), through a copy of the index */
async function snapshotTree(root: string) {
  const gitDir = (await git(root, ["rev-parse", "--absolute-git-dir"])).trim();
  const tmp = path.join(os.tmpdir(), `agent-u-index-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  /* starting from the real index lets git reuse its stat cache, so a big repo snapshots fast */
  await fs.copyFile(path.join(gitDir, "index"), tmp).catch(() => undefined);
  try {
    const env = { GIT_INDEX_FILE: tmp };
    await git(root, ["add", "-A", "--", "."], { env, timeout: 60_000 });
    return (await git(root, ["write-tree"], { env })).trim();
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

export async function listCheckpoints(cwd: string, session: string): Promise<Checkpoint[]> {
  const root = await repoRoot(cwd);
  if (!root) return [];
  const out = await git(root, ["for-each-ref", "--sort=-refname", "--format=%(refname)%09%(objectname)%09%(tree)%09%(contents:subject)", `${refBase(session)}/`]).catch(() => "");
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ref, commit, tree, ...rest] = line.split("\t");
      const id = ref.slice(ref.lastIndexOf("/") + 1);
      return { id, commit, tree, at: Number(id.split("-")[0]) || 0, label: rest.join("\t") };
    });
}

/** Saves the folder's current state for this session, unless it's the same as the last checkpoint. */
export async function checkpoint(cwd: string, session: string, label: string): Promise<Checkpoint | null> {
  const root = await repoRoot(cwd);
  if (!root) return null;
  const tree = await snapshotTree(root);
  const list = await listCheckpoints(root, session);
  if (list[0]?.tree === tree) return list[0];
  const head = (await git(root, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => "")).trim();
  const subject = label.replace(/\s+/g, " ").trim().slice(0, 120) || "Checkpoint";
  const commit = (await git(root, ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", subject], { env: BOT })).trim();
  const id = `${Date.now()}-${crypto.randomBytes(2).toString("hex")}`;
  await git(root, ["update-ref", `${refBase(session)}/${id}`, commit]);
  for (const old of list.slice(MAX_CHECKPOINTS - 1)) await git(root, ["update-ref", "-d", `${refBase(session)}/${old.id}`]).catch(() => undefined);
  return { id, commit, tree, at: Number(id.split("-")[0]), label: subject };
}

/** Checkpoints taken before a session had its id (a first message) move to it once it does. */
export async function moveCheckpoints(cwd: string, from: string, to: string) {
  const root = await repoRoot(cwd);
  if (!root || from === to) return;
  for (const c of await listCheckpoints(root, from)) {
    await git(root, ["update-ref", `${refBase(to)}/${c.id}`, c.commit]);
    await git(root, ["update-ref", "-d", `${refBase(from)}/${c.id}`]);
  }
}

export type FileStat = { path: string; added: number; removed: number; binary: boolean };

function numstat(out: string): FileStat[] {
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [a, r, ...p] = l.split("\t");
      return { path: p.join("\t"), added: a === "-" ? 0 : Number(a), removed: r === "-" ? 0 : Number(r), binary: a === "-" };
    });
}

/** what changed in the folder since a checkpoint */
export async function sinceCheckpoint(cwd: string, session: string, id: string): Promise<FileStat[]> {
  const root = await needRoot(cwd);
  const cp = (await listCheckpoints(root, session)).find((c) => c.id === id);
  if (!cp) throw new GitError("That checkpoint is gone.", 404);
  const now = await snapshotTree(root);
  return numstat(await git(root, ["diff", "--numstat", "--no-renames", cp.tree, now]));
}

/** Puts the folder's files back the way they were at a checkpoint. The state before is saved first, so this can be undone. */
export async function rewind(cwd: string, session: string, id: string) {
  const root = await needRoot(cwd);
  const cp = (await listCheckpoints(root, session)).find((c) => c.id === id);
  if (!cp) throw new GitError("That checkpoint is gone.", 404);
  const when = new Date(cp.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const before = await checkpoint(root, session, `Before rewinding to ${when}`);
  if (!before || before.tree === cp.tree) return { changed: 0, removed: 0, undo: before?.id ?? null };
  const changes = numstat(await git(root, ["diff", "--numstat", "--no-renames", cp.tree, before.tree]));
  const added = (await git(root, ["diff", "--name-only", "--no-renames", "--diff-filter=A", "-z", cp.tree, before.tree])).split("\0").filter(Boolean);
  const tmp = path.join(os.tmpdir(), `agent-u-index-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  try {
    const env = { GIT_INDEX_FILE: tmp };
    await git(root, ["read-tree", cp.tree], { env });
    await git(root, ["checkout-index", "-a", "-f"], { env, timeout: 60_000 });
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
  for (const rel of added) {
    const abs = path.resolve(root, rel);
    if (abs.startsWith(`${root}${path.sep}`)) await fs.rm(abs, { force: true }).catch(() => undefined);
  }
  return { changed: changes.length, removed: added.length, undo: before.id };
}

/* ── status, commit, push, pull request ──────────────── */

export type GitStatus = {
  root: string;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: { path: string; state: string }[];
  remote: boolean;
  gh: boolean;
};

let ghPath: Promise<boolean> | null = null;
const hasGh = () => (ghPath ??= git(os.homedir(), ["--version"], { bin: "gh", timeout: 5000 }).then(() => true, () => false));

export async function status(cwd: string): Promise<GitStatus | null> {
  const root = await repoRoot(cwd);
  if (!root) return null;
  const [out, remotes, gh] = await Promise.all([git(root, ["status", "--porcelain=v1", "--branch", "-z", "--untracked-files=all"]), git(root, ["remote"]).catch(() => ""), hasGh()]);
  const parts = out.split("\0").filter(Boolean);
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: GitStatus["files"] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.startsWith("## ")) {
      /* "## main...origin/main [ahead 1, behind 2]", "## No commits yet on main", "## HEAD (no branch)" */
      let head = p.slice(3);
      const counts = / \[(.*)\]$/.exec(head);
      if (counts) head = head.slice(0, counts.index);
      const [b, up] = head.replace(/^(No commits yet|Initial commit) on /, "").split("...");
      branch = b.startsWith("HEAD (") ? null : b;
      upstream = up ?? null;
      ahead = Number(/ahead (\d+)/.exec(counts?.[1] ?? "")?.[1] ?? 0);
      behind = Number(/behind (\d+)/.exec(counts?.[1] ?? "")?.[1] ?? 0);
      continue;
    }
    const state = p.slice(0, 2);
    files.push({ path: p.slice(3), state });
    /* a rename carries its old name as the next part */
    if (state[0] === "R" || state[0] === "C") i++;
  }
  return { root, branch, upstream, ahead, behind, files, remote: Boolean(remotes.trim()), gh };
}

export async function commitAll(cwd: string, message: string) {
  const root = await needRoot(cwd);
  const msg = message.trim();
  if (!msg) throw new GitError("Write a commit message first.");
  await git(root, ["add", "-A"]);
  try {
    await git(root, ["commit", "-m", msg]);
  } catch (err) {
    const m = (err as Error).message;
    if (/Please tell me who you are|user\.email|user\.name/.test(m)) throw new GitError("Git doesn't know who you are on the server. Set user.name and user.email (git config --global) in a terminal first.");
    if (/nothing to commit/.test(m)) throw new GitError("Nothing to commit.");
    throw err;
  }
  return (await git(root, ["rev-parse", "--short", "HEAD"])).trim();
}

export async function push(cwd: string) {
  const root = await needRoot(cwd);
  const st = await status(root);
  if (!st?.remote) throw new GitError("This repository has no remote to push to.");
  if (!st.branch) throw new GitError("Not on a branch (detached HEAD).");
  await git(root, st.upstream ? ["push"] : ["push", "-u", "origin", "HEAD"], { timeout: 120_000 });
  return st.branch;
}

export async function pullRequest(cwd: string, title?: string) {
  const root = await needRoot(cwd);
  if (!(await hasGh())) throw new GitError("Creating a pull request needs the GitHub CLI (gh) on the server.");
  await push(root);
  const args = ["pr", "create", ...(title?.trim() ? ["--title", title.trim(), "--body", ""] : ["--fill"])];
  try {
    const out = await git(root, args, { bin: "gh", timeout: 60_000 });
    return out.trim().split("\n").pop() ?? "";
  } catch (err) {
    const m = (err as Error).message;
    const existing = /(https:\/\/\S+\/pull\/\d+)/.exec(m)?.[1];
    if (existing) return existing;
    if (/auth login|not logged/i.test(m)) throw new GitError("gh isn't signed in on the server. Run gh auth login in a terminal.");
    throw err;
  }
}

/* ── worktrees ──────────────────────────────────────── */

export const WORKTREE_ROOT = process.env.AGENT_U_WORKTREES || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "agent-u", "worktrees");

/** A new branch checked out in its own folder, so a session can work without touching the main checkout. */
export async function newWorktree(cwd: string, name: string) {
  const root = await needRoot(cwd);
  const head = (await git(root, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => "")).trim();
  if (!head) throw new GitError("The repository has no commits yet, so there's nothing to branch from.");
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "session";
  const stamp = new Date().toISOString().slice(5, 16).replace(/[-T:]/g, "");
  const branch = `agent-u/${slug}-${stamp}`;
  const dir = path.join(WORKTREE_ROOT, path.basename(root), `${slug}-${stamp}`);
  await fs.mkdir(path.dirname(dir), { recursive: true });
  await git(root, ["worktree", "add", "-b", branch, dir, "HEAD"], { timeout: 120_000 });
  /* the session starts in the same place inside the repo it was asked for */
  const sub = path.relative(root, path.resolve(cwd));
  const start = sub && !sub.startsWith("..") ? path.join(dir, sub) : dir;
  return { dir: await fs.stat(start).then(() => start, () => dir), branch };
}
