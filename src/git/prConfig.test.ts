import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getGhHost, isSafeGhHost, setGhHost } from "./prConfig";

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

describe("pr-config persistence", () => {
  test("remembers a host per repo and rejects an unsafe one", async () => {
    const directory = await tempDir();
    expect(await getGhHost("/tmp/app", directory)).toBeNull();
    await setGhHost("/tmp/app", "github.example.com", directory);
    expect(await getGhHost("/tmp/app", directory)).toBe("github.example.com");
    expect(await getGhHost("/tmp/other", directory)).toBeNull();
    await expect(setGhHost("/tmp/app", "bad host", directory)).rejects.toThrow(
      "invalid GitHub host",
    );
  });
});
