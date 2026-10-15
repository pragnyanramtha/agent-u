import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentu-git-"));
process.env.AGENT_U_WORKTREES = path.join(tmp, "worktrees");
const repo = path.join(tmp, "repo");
const remote = path.join(tmp, "remote.git");
let g: typeof import("@/lib/server/git");

const sh = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const write = (p: string, s: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true });
  fs.writeFileSync(path.join(repo, p), s);
};
const read = (p: string) => fs.readFileSync(path.join(repo, p), "utf8");
const exists = (p: string) => fs.existsSync(path.join(repo, p));

beforeAll(async () => {
  g = await import("@/lib/server/git");
  fs.mkdirSync(repo);
  sh(["init", "-q", "-b", "main"]);
  sh(["config", "user.name", "t"]);
  sh(["config", "user.email", "t@t"]);
  write(".gitignore", "secret.env\n");
  write("a.txt", "one\n");
  sh(["add", "-A"]);
  sh(["commit", "-qm", "init"]);
  execFileSync("git", ["init", "-q", "--bare", remote]);
  sh(["remote", "add", "origin", remote]);
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("checkpoints", () => {
  it("snapshot the folder without touching HEAD, the index or the branch", async () => {
    write("a.txt", "two\n");
    write("new/b.txt", "bee\n");
    write("secret.env", "KEY=1\n");
    const head = sh(["rev-parse", "HEAD"]);
    const status = sh(["status", "--porcelain"]);
    const cp = await g.checkpoint(path.join(repo, "new"), "s1", "Fix the\nlogin");
    expect(cp).toMatchObject({ label: "Fix the login" });
    expect(sh(["rev-parse", "HEAD"])).toBe(head);
    expect(sh(["status", "--porcelain"])).toBe(status);
    expect(sh(["branch", "--list"]).trim()).toBe("* main");
    /* ignored files stay out */
    expect(sh(["ls-tree", "-r", "--name-only", cp!.commit])).not.toContain("secret.env");
  });

  it("skip a checkpoint when nothing changed", async () => {
    const before = await g.listCheckpoints(repo, "s1");
    const again = await g.checkpoint(repo, "s1", "same");
    expect(again?.id).toBe(before[0].id);
    expect(await g.listCheckpoints(repo, "s1")).toHaveLength(1);
  });

  it("keep sessions apart", async () => {
    expect(await g.listCheckpoints(repo, "s2")).toEqual([]);
  });

  it("rewind files, remove files made since, and can be undone", async () => {
    const [cp] = await g.listCheckpoints(repo, "s1");
    write("a.txt", "three\n");
    write("new/c.txt", "sea\n");
    fs.rmSync(path.join(repo, "new/b.txt"));
    const since = await g.sinceCheckpoint(repo, "s1", cp.id);
    expect(since.map((f) => f.path).sort()).toEqual(["a.txt", "new/b.txt", "new/c.txt"]);

    const res = await g.rewind(repo, "s1", cp.id);
    expect(res).toMatchObject({ changed: 3, removed: 1 });
    expect(read("a.txt")).toBe("two\n");
    expect(read("new/b.txt")).toBe("bee\n");
    expect(exists("new/c.txt")).toBe(false);
    expect(read("secret.env")).toBe("KEY=1\n");

    await g.rewind(repo, "s1", res.undo!);
    expect(read("a.txt")).toBe("three\n");
    expect(read("new/c.txt")).toBe("sea\n");
    expect(exists("new/b.txt")).toBe(false);
  });

  it("move from a provisional key to the session id", async () => {
    write("a.txt", "four\n");
    await g.checkpoint(repo, "pending-x", "first");
    await g.moveCheckpoints(repo, "pending-x", "real-id");
    expect(await g.listCheckpoints(repo, "pending-x")).toEqual([]);
    expect((await g.listCheckpoints(repo, "real-id"))[0].label).toBe("first");
  });

  it("do nothing outside a repository", async () => {
    expect(await g.checkpoint(tmp, "s1", "x")).toBeNull();
    expect(await g.listCheckpoints(tmp, "s1")).toEqual([]);
  });
});

describe("status, commit, push", () => {
  it("reports branch, upstream and files", async () => {
    const st = await g.status(repo);
    expect(st).toMatchObject({ root: fs.realpathSync(repo), branch: "main", upstream: null, remote: true });
    expect(st!.files.map((f) => f.path)).toContain("a.txt");
  });

  it("commits everything, pushes with an upstream, then counts ahead", async () => {
    expect(await g.commitAll(repo, "work")).toMatch(/^[0-9a-f]{7,}$/);
    await expect(g.commitAll(repo, "again")).rejects.toThrow("Nothing to commit.");
    await expect(g.commitAll(repo, "  ")).rejects.toThrow("commit message");
    expect(await g.push(repo)).toBe("main");
    let st = await g.status(repo);
    expect(st).toMatchObject({ upstream: "origin/main", ahead: 0, files: [] });
    write("a.txt", "five\n");
    await g.commitAll(repo, "more");
    st = await g.status(repo);
    expect(st?.ahead).toBe(1);
  });
});

describe("worktrees", () => {
  it("make a branch in its own folder, starting in the same subfolder", async () => {
    const wt = await g.newWorktree(path.join(repo, "new"), "Fix Login!");
    expect(wt.branch).toMatch(/^agent-u\/fix-login-\d{8}$/);
    expect(wt.dir.startsWith(path.join(tmp, "worktrees", "repo"))).toBe(true);
    expect(path.basename(wt.dir)).toBe("new");
    expect(sh(["worktree", "list"])).toContain(path.dirname(wt.dir));
    expect(sh(["branch", "--list", wt.branch]).trim()).toContain(wt.branch);
  });
});
