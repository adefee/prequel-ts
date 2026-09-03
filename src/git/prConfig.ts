// Tiny per-repo settings for PR-comment providers: GHE hostname + per-provider PATs.
import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_COMMENT_DIR } from "../comments/commentStore";

interface RepoPrConfig {
  ghHost?: string;
  /** @deprecated Prefer tokens.forgejo — still read/written for compat. */
  forgeToken?: string;
  tokens?: Record<string, string>;
}

interface PrConfig {
  [repoRoot: string]: RepoPrConfig;
}

function fileFor(directory: string): string {
  return path.join(directory, "pr-config.json");
}

async function readConfig(directory: string): Promise<PrConfig> {
  try {
    const raw = JSON.parse(await fs.readFile(fileFor(directory), "utf8")) as unknown;
    return raw && typeof raw === "object" ? (raw as PrConfig) : {};
  } catch {
    return {};
  }
}

async function writeRepoConfig(
  repoRoot: string,
  patch: RepoPrConfig,
  directory: string,
): Promise<void> {
  const dir = directory ?? DEFAULT_COMMENT_DIR;
  const cfg = await readConfig(dir);
  const prev = cfg[repoRoot] ?? {};
  const tokens = patch.tokens !== undefined ? { ...prev.tokens, ...patch.tokens } : prev.tokens;
  cfg[repoRoot] = { ...prev, ...patch, ...(tokens ? { tokens } : {}) };
  await fs.mkdir(dir, { recursive: true });
  const dest = fileFor(dir);
  const tmp = `${dest}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2));
  await fs.rename(tmp, dest);
}

/** Hostname or hostname:port. Used as `GH_HOST`, so reject anything else. */
export function isSafeGhHost(host: string): boolean {
  if (!host || host.length > 253) {
    return false;
  }
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*(?::\d{1,5})?$/.test(
    host,
  );
}

/** Non-empty PAT without whitespace / control chars. */
export function isSafeProviderToken(token: string): boolean {
  if (!token || token.length > 200) {
    return false;
  }
  return /^[A-Za-z0-9._~+/=-]+$/.test(token);
}

/** @deprecated Use isSafeProviderToken. */
export const isSafeForgeToken = isSafeProviderToken;

const PROVIDER_ID = /^[a-z][a-z0-9_-]{0,31}$/;

export function isSafeProviderId(id: string): boolean {
  return PROVIDER_ID.test(id);
}

export async function getGhHost(
  repoRoot: string,
  directory = DEFAULT_COMMENT_DIR,
): Promise<string | null> {
  const cfg = await readConfig(directory ?? DEFAULT_COMMENT_DIR);
  return cfg[repoRoot]?.ghHost ?? null;
}

export async function setGhHost(
  repoRoot: string,
  ghHost: string,
  directory = DEFAULT_COMMENT_DIR,
): Promise<void> {
  if (!isSafeGhHost(ghHost)) {
    throw new Error("invalid GitHub host");
  }
  await writeRepoConfig(repoRoot, { ghHost }, directory ?? DEFAULT_COMMENT_DIR);
}

export async function getProviderToken(
  repoRoot: string,
  providerId: string,
  directory = DEFAULT_COMMENT_DIR,
): Promise<string | null> {
  const cfg = await readConfig(directory ?? DEFAULT_COMMENT_DIR);
  const entry = cfg[repoRoot];
  if (!entry) {
    return null;
  }
  const fromMap = entry.tokens?.[providerId];
  if (fromMap) {
    return fromMap;
  }
  // Legacy single-field storage for the Forgejo provider.
  if (providerId === "forgejo" && entry.forgeToken) {
    return entry.forgeToken;
  }
  return null;
}

export async function setProviderToken(
  repoRoot: string,
  providerId: string,
  token: string,
  directory = DEFAULT_COMMENT_DIR,
): Promise<void> {
  if (!isSafeProviderId(providerId)) {
    throw new Error("invalid provider id");
  }
  if (!isSafeProviderToken(token)) {
    throw new Error("invalid provider token");
  }
  const patch: RepoPrConfig = { tokens: { [providerId]: token } };
  if (providerId === "forgejo") {
    patch.forgeToken = token;
  }
  await writeRepoConfig(repoRoot, patch, directory ?? DEFAULT_COMMENT_DIR);
}

/** @deprecated Use getProviderToken(repo, "forgejo"). */
export async function getForgeToken(
  repoRoot: string,
  directory = DEFAULT_COMMENT_DIR,
): Promise<string | null> {
  return getProviderToken(repoRoot, "forgejo", directory);
}

/** @deprecated Use setProviderToken(repo, "forgejo", token). */
export async function setForgeToken(
  repoRoot: string,
  forgeToken: string,
  directory = DEFAULT_COMMENT_DIR,
): Promise<void> {
  await setProviderToken(repoRoot, "forgejo", forgeToken, directory);
}
