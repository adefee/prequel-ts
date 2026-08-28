// Tiny per-repo settings for the PR-comment importer — currently just the
// GitHub Enterprise hostname, so it only has to be entered once per repo.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const FILE = path.join(os.homedir(), '.prequel', 'pr-config.json');

interface PrConfig {
  [repoRoot: string]: { ghHost?: string };
}

async function readConfig(): Promise<PrConfig> {
  try {
    const raw = JSON.parse(await fs.readFile(FILE, 'utf8')) as unknown;
    return raw && typeof raw === 'object' ? (raw as PrConfig) : {};
  } catch {
    return {};
  }
}

export async function getGhHost(repoRoot: string): Promise<string | null> {
  const cfg = await readConfig();
  return cfg[repoRoot]?.ghHost ?? null;
}

export async function setGhHost(repoRoot: string, ghHost: string): Promise<void> {
  const cfg = await readConfig();
  cfg[repoRoot] = { ...cfg[repoRoot], ghHost };
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2));
  await fs.rename(tmp, FILE);
}
