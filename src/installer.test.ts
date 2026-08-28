import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { install } from "./installer";

const tmpDirs: string[] = [];
async function tmpCwd(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "prequel-install-"));
  const real = await fs.realpath(dir);
  tmpDirs.push(real);
  return real;
}
afterAll(async () =>
  Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))),
);

describe("install", () => {
  test("installs, recognizes, protects, and force-replaces one real file", async () => {
    const cwd = await tmpCwd();
    const installed = await install("claude", { project: true, cwd });
    expect(installed).toMatchObject({
      status: "installed",
      dest: path.join(cwd, ".claude", "skills", "prequel", "SKILL.md"),
    });
    expect((await fs.lstat(installed.dest!)).isSymbolicLink()).toBe(false);
    const shipped = await fs.readFile(installed.dest!, "utf8");
    expect(shipped).toContain("Working a prequel review");
    expect((await install("claude", { project: true, cwd })).status).toBe("current");

    await fs.writeFile(installed.dest!, "local customization");
    expect((await install("claude", { project: true, cwd })).status).toBe("conflict");
    expect(await fs.readFile(installed.dest!, "utf8")).toBe("local customization");
    expect((await install("claude", { project: true, force: true, cwd })).status).toBe("updated");
    expect(await fs.readFile(installed.dest!, "utf8")).toBe(shipped);
  });

  test("returns unknown target without a destination", async () => {
    expect(await install("unknown")).toEqual({ status: "unknown-target", dest: null });
  });

  test("refuses symbolic-link destinations and ancestors without clobbering", async () => {
    const cwd = await tmpCwd();
    const real = path.join(cwd, "real");
    await fs.mkdir(real);
    const ancestor = path.join(cwd, ".claude");
    await fs.symlink(real, ancestor);
    await expect(install("claude", { project: true, force: true, cwd })).rejects.toThrow(
      /symbolic link/,
    );

    await fs.rm(ancestor);
    const dir = path.join(cwd, ".claude", "skills", "prequel");
    await fs.mkdir(dir, { recursive: true });
    const outside = path.join(cwd, "outside.md");
    await fs.writeFile(outside, "do not clobber");
    await fs.symlink(outside, path.join(dir, "SKILL.md"));
    await expect(install("claude", { project: true, force: true, cwd })).rejects.toThrow(
      /symbolic link/,
    );
    expect(await fs.readFile(outside, "utf8")).toBe("do not clobber");
  });
});
