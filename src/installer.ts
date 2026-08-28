// Installs prequel's agent integration. Targets are keyed by agent because
// each one wants a different artifact in a different place — Claude Code takes
// a skill under .claude/skills, others would take their own file.
//
// Installs go to the user's home directory by default rather than the reviewed
// repo, because prequel is run *against* other repos: a project-scoped skill
// wouldn't load in them.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface Target {
  label: string;
  source: string;
  dir: string;
  file: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
// Add an agent by adding a row here: where its artifact lives, and what the
// source file is.
const TARGETS: Record<string, Target> = {
  claude: {
    label: "Claude Code",
    source: path.resolve(here, "..", "skills", "prequel", "SKILL.md"),
    dir: path.join(".claude", "skills", "prequel"),
    file: "SKILL.md",
  },
};

export const TARGET_NAMES = Object.keys(TARGETS);

export interface InstallOptions {
  project?: boolean;
  force?: boolean;
  cwd?: string;
}

export type InstallStatus = "installed" | "updated" | "current" | "conflict" | "unknown-target";

export interface InstallResult {
  status: InstallStatus;
  dest: string | null;
}

export function targetPath(
  target: string,
  { project = false, cwd = process.cwd() }: InstallOptions = {},
): string {
  const t = TARGETS[target]!;
  const base = project ? cwd : os.homedir();
  return path.join(base, t.dir, t.file);
}

async function readOrNull(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
}

function isEnoent(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "ENOENT";
}

// Refuse to mkdir/write through a symlink at dest or any existing ancestor
// (including dest itself on --force overwrite).
async function rejectSymlinkPath(dest: string): Promise<void> {
  let current = path.resolve(dest);
  for (;;) {
    try {
      const st = await fs.lstat(current);
      if (st.isSymbolicLink()) {
        throw new Error(`refusing to install through a symbolic link: ${current}`);
      }
    } catch (err) {
      if (!isEnoent(err)) {
        throw err;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
}

// `conflict` means the file on disk was edited; we refuse to clobber it
// without --force so local customizations aren't silently lost.
export async function install(
  target: string,
  { project = false, force = false, cwd = process.cwd() }: InstallOptions = {},
): Promise<InstallResult> {
  const t = TARGETS[target];
  if (!t) {
    return { status: "unknown-target", dest: null };
  }
  const source = await fs.readFile(t.source, "utf8");
  const dest = targetPath(target, { project, cwd });
  const existing = await readOrNull(dest);

  if (existing === source) {
    return { status: "current", dest };
  }
  if (existing !== null && !force) {
    return { status: "conflict", dest };
  }

  await rejectSymlinkPath(dest);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, source);
  return { status: existing === null ? "installed" : "updated", dest };
}

// Names of installed integrations that no longer match the shipped copy —
// used to nudge after an upgrade. Never includes uninstalled targets.
export async function staleTargets(): Promise<string[]> {
  const stale: string[] = [];
  for (const [name, t] of Object.entries(TARGETS)) {
    try {
      const existing = await readOrNull(targetPath(name));
      if (existing !== null && existing !== (await fs.readFile(t.source, "utf8"))) {
        stale.push(name);
      }
    } catch {
      /* unreadable home dir — nothing to report */
    }
  }
  return stale;
}
