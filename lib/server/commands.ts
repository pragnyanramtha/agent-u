import fs from "node:fs/promises";
import path from "node:path";
import { BUILTIN_COMMANDS, type SlashItem } from "@/lib/commands";
import { CLAUDE_HOME } from "./config";

/* Custom commands (~/.claude/commands, <cwd>/.claude/commands) and skills
 * (~/.claude/skills, <cwd>/.claude/skills), with their frontmatter descriptions. */

const cache = new Map<string, { at: number; items: SlashItem[] }>();

async function head(file: string) {
  const handle = await fs.open(file, "r").catch(() => null);
  if (!handle) return "";
  try {
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function describe(text: string) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  /* plain `description: text`, or a YAML block scalar (`description: >` with indented lines) */
  const block = fm && /^description:\s*[>|][-+]?\s*\n((?:[ \t]+.*\n?)+)/m.exec(fm[1])?.[1];
  const desc = block ? block.replace(/\s+/g, " ") : fm && /^description:\s*(.+)$/m.exec(fm[1])?.[1];
  const body = (fm ? text.slice(fm[0].length) : text).split("\n").find((l) => l.trim() && !l.startsWith("#"));
  return (desc ?? body ?? "").replace(/^["']|["']$/g, "").trim().slice(0, 160);
}

async function commandsIn(dir: string, prefix = ""): Promise<SlashItem[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out = await Promise.all(
    entries.map(async (e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return commandsIn(full, `${prefix}${e.name}:`);
      if (!e.name.endsWith(".md")) return [];
      return [{ name: `${prefix}${e.name.slice(0, -3)}`, description: describe(await head(full)), kind: "command" as const }];
    }),
  );
  return out.flat();
}

async function skillsIn(dir: string): Promise<SlashItem[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out = await Promise.all(
    entries
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map(async (e) => {
        const text = await head(path.join(dir, e.name, "SKILL.md"));
        if (!text) return null;
        const name = /^name:\s*(.+)$/m.exec(text)?.[1]?.trim() || e.name;
        return { name, description: describe(text), kind: "skill" as const };
      }),
  );
  return out.filter((x): x is NonNullable<typeof x> => x !== null);
}

export async function listCommands(cwd?: string): Promise<SlashItem[]> {
  const key = cwd ?? "";
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.items;
  const project = cwd && path.isAbsolute(cwd) ? path.join(cwd, ".claude") : null;
  const [userCmds, projCmds, userSkills, projSkills] = await Promise.all([
    commandsIn(path.join(CLAUDE_HOME, "commands")),
    project ? commandsIn(path.join(project, "commands")) : [],
    skillsIn(path.join(CLAUDE_HOME, "skills")),
    project ? skillsIn(path.join(project, "skills")) : [],
  ]);
  const seen = new Set<string>();
  const items = [...BUILTIN_COMMANDS, ...projCmds, ...userCmds, ...projSkills, ...userSkills].filter((c) => !seen.has(c.name) && seen.add(c.name));
  cache.set(key, { at: Date.now(), items });
  return items;
}
