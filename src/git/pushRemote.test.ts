import { afterAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isGithubDotCom, parseRemoteUrl, resolvePushRemote } from "./pushRemote";

const dirs: string[] = [];
afterAll(async () => Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))));

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
        return;
      }
      resolve(stdout);
    });
  });
}

async function tempRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "prequel-push-remote-"));
  dirs.push(dir);
  await git(dir, ["init"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  await git(dir, ["config", "commit.gpgsign", "false"]);
  await fs.writeFile(path.join(dir, "a.txt"), "a\n");
  await git(dir, ["add", "a.txt"]);
  await git(dir, ["commit", "-m", "init"]);
  return dir;
}

describe("parseRemoteUrl", () => {
  test("parses https, ssh, and scp-like remotes", () => {
    expect(parseRemoteUrl("https://code.example/acme/app.git")).toEqual({
      url: "https://code.example/acme/app.git",
      baseUrl: "https://code.example",
      host: "code.example",
      owner: "acme",
      repo: "app",
    });
    expect(parseRemoteUrl("https://forge.ts.net:3000/org/repo")).toEqual({
      url: "https://forge.ts.net:3000/org/repo",
      baseUrl: "https://forge.ts.net:3000",
      host: "forge.ts.net:3000",
      owner: "org",
      repo: "repo",
    });
    expect(parseRemoteUrl("git@code.example:acme/app.git")).toEqual({
      url: "git@code.example:acme/app.git",
      baseUrl: "https://code.example",
      host: "code.example",
      owner: "acme",
      repo: "app",
    });
    expect(parseRemoteUrl("ssh://git@code.example/acme/app.git")).toEqual({
      url: "ssh://git@code.example/acme/app.git",
      baseUrl: "https://code.example",
      host: "code.example",
      owner: "acme",
      repo: "app",
    });
    expect(parseRemoteUrl("not a url")).toBeNull();
  });
});

describe("isGithubDotCom", () => {
  test("matches github.com only", () => {
    expect(isGithubDotCom("github.com")).toBe(true);
    expect(isGithubDotCom("api.github.com")).toBe(true);
    expect(isGithubDotCom("code.adieuu.com")).toBe(false);
    expect(isGithubDotCom("github.example.com")).toBe(false);
  });
});

describe("resolvePushRemote", () => {
  test("prefers pushurl over fetch url and honors pushRemote", async () => {
    const repo = await tempRepo();
    await git(repo, ["remote", "add", "origin", "https://public.example/acme/app.git"]);
    await git(repo, [
      "remote",
      "set-url",
      "--push",
      "origin",
      "https://tailnet.example/acme/app.git",
    ]);
    await git(repo, ["branch", "-M", "main"]);

    const fromOrigin = await resolvePushRemote(repo, "main");
    expect(fromOrigin).toMatchObject({
      remoteName: "origin",
      baseUrl: "https://tailnet.example",
      owner: "acme",
      repo: "app",
    });

    await git(repo, ["remote", "add", "forge", "https://forge.example/acme/app.git"]);
    await git(repo, ["config", "branch.main.pushRemote", "forge"]);
    const fromPushRemote = await resolvePushRemote(repo, "main");
    expect(fromPushRemote).toMatchObject({
      remoteName: "forge",
      baseUrl: "https://forge.example",
      owner: "acme",
      repo: "app",
    });
  });
});
