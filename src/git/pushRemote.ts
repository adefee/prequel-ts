// Resolve the remote URL git would use for push, and parse a target origin +
// owner/repo from it. Used by the PR-comment importer so API calls (like this in Forgejo) hit the same host as writes (e.g. Tailscale pushurl), never the public fetch URL.
import { execFile } from "node:child_process";

function git(repoRoot: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", repoRoot, ...args],
      { maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr.trim() || err.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function gitConfig(repoRoot: string, key: string): Promise<string | null> {
  try {
    const out = await git(repoRoot, ["config", "--get", key]);
    const value = out.trim();
    return value || null;
  } catch {
    return null;
  }
}

export interface PushRemote {
  remoteName: string;
  url: string;
  /** Origin for HTTP API calls, e.g. https://forge.example:3000 */
  baseUrl: string;
  host: string;
  owner: string;
  repo: string;
}

/** True for github.com and its subdomains (not arbitrary GHE hosts). */
export function isGithubDotCom(host: string): boolean {
  const h = host.toLowerCase();
  return h === "github.com" || h.endsWith(".github.com");
}

/**
 * Parse a git remote URL into forge coordinates.
 * Supports https://, http://, ssh://, and scp-like git@host:path forms.
 */
export function parseRemoteUrl(raw: string): Omit<PushRemote, "remoteName"> | null {
  const url = raw.trim();
  if (!url) {
    return null;
  }

  // scp-like: git@host:owner/repo.git  (also host:owner/repo)
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(url);
  if (scp && !url.includes("://")) {
    const host = scp[1]!;
    const pathPart = scp[2]!.replace(/^\/+/, "");
    const parsed = splitOwnerRepo(pathPart);
    if (!parsed) {
      return null;
    }
    return {
      url,
      baseUrl: `https://${host}`,
      host,
      owner: parsed.owner,
      repo: parsed.repo,
    };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }

  if (!parsedUrl.protocol || !parsedUrl.hostname) {
    return null;
  }

  const host = parsedUrl.hostname;
  // Only keep an explicit port from http(s) remotes — ssh://…:22 is not the API port.
  const httpRemote = parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";
  const scheme = parsedUrl.protocol === "http:" ? "http" : "https";
  const hostWithPort = httpRemote && parsedUrl.port ? `${host}:${parsedUrl.port}` : host;
  const pathPart = parsedUrl.pathname.replace(/^\/+/, "");
  const ownerRepo = splitOwnerRepo(pathPart);
  if (!ownerRepo) {
    return null;
  }

  return {
    url,
    baseUrl: `${scheme}://${hostWithPort}`,
    host: hostWithPort,
    owner: ownerRepo.owner,
    repo: ownerRepo.repo,
  };
}

function splitOwnerRepo(pathPart: string): { owner: string; repo: string } | null {
  const cleaned = pathPart
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean);
  // Allow optional nesting prefix (e.g. forgejo org paths are still owner/repo)
  if (cleaned.length < 2) {
    return null;
  }
  const owner = cleaned[cleaned.length - 2]!;
  const repo = cleaned[cleaned.length - 1]!;
  if (!owner || !repo || owner.includes("..") || repo.includes("..")) {
    return null;
  }
  return { owner, repo };
}

/**
 * Pick the remote name git would push to for `branch`, then its push URL.
 * Order: branch.<name>.pushRemote → remote.pushDefault → branch.<name>.remote → origin.
 */
export async function resolvePushRemote(
  repoRoot: string,
  branch: string,
): Promise<PushRemote | null> {
  const pushRemote =
    (await gitConfig(repoRoot, `branch.${branch}.pushRemote`)) ||
    (await gitConfig(repoRoot, "remote.pushDefault")) ||
    (await gitConfig(repoRoot, `branch.${branch}.remote`)) ||
    "origin";

  let url: string;
  try {
    url = (await git(repoRoot, ["remote", "get-url", "--push", pushRemote])).trim();
  } catch {
    return null;
  }
  if (!url) {
    return null;
  }
  const parsed = parseRemoteUrl(url);
  if (!parsed) {
    return null;
  }
  return { remoteName: pushRemote, ...parsed };
}
