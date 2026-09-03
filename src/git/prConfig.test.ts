import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getForgeToken,
  getGhHost,
  isSafeForgeToken,
  isSafeGhHost,
  setForgeToken,
  setGhHost,
} from "./prConfig";

const dirs: string[] = [];
afterAll(async () => Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))));

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "prequel-pr-config-"));
  dirs.push(dir);
  return dir;
}

describe("isSafeGhHost", () => {
  test("accepts hostnames and rejects injection-shaped input", () => {
    expect(isSafeGhHost("github.com")).toBe(true);
    expect(isSafeGhHost("github.example.com")).toBe(true);
    expect(isSafeGhHost("ghe.internal:8443")).toBe(true);
    expect(isSafeGhHost("evil.com;rm -rf /")).toBe(false);
    expect(isSafeGhHost("host/path")).toBe(false);
    expect(isSafeGhHost("-leading")).toBe(false);
    expect(isSafeGhHost("")).toBe(false);
  });
});

describe("isSafeForgeToken", () => {
  test("accepts typical PATs and rejects whitespace", () => {
    expect(isSafeForgeToken("abc123._~+-/=XYZ")).toBe(true);
    expect(isSafeForgeToken("")).toBe(false);
    expect(isSafeForgeToken("has space")).toBe(false);
    expect(isSafeForgeToken("bad\ntoken")).toBe(false);
  });
});

describe("pr-config persistence", () => {
  test("remembers a host and token per repo", async () => {
    const directory = await tempDir();
    expect(await getGhHost("/tmp/app", directory)).toBeNull();
    await setGhHost("/tmp/app", "github.example.com", directory);
    expect(await getGhHost("/tmp/app", directory)).toBe("github.example.com");
    expect(await getGhHost("/tmp/other", directory)).toBeNull();
    await expect(setGhHost("/tmp/app", "bad host", directory)).rejects.toThrow(
      "invalid GitHub host",
    );

    expect(await getForgeToken("/tmp/app", directory)).toBeNull();
    await setForgeToken("/tmp/app", "forge-pat-xyz", directory);
    expect(await getForgeToken("/tmp/app", directory)).toBe("forge-pat-xyz");
    expect(await getGhHost("/tmp/app", directory)).toBe("github.example.com");
    await expect(setForgeToken("/tmp/app", "bad token", directory)).rejects.toThrow(
      "invalid Forgejo token",
    );
  });
});
