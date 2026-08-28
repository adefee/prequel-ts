import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseDiff } from "./diff";

const dirs: string[] = [];
function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

afterAll(async () => Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))));

describe("parseDiff review mapping", () => {
  test("maps representative patches produced by Git", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "prequel-parser-"));
    dirs.push(repo);
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    await fs.writeFile(path.join(repo, "text.txt"), "old line\ncontext\n");
    await fs.writeFile(path.join(repo, "gone.md"), "gone\n");
    await fs.writeFile(path.join(repo, "old.md"), "move me\n");
    await fs.writeFile(path.join(repo, "copy-source.md"), "copy me\n");
    await fs.writeFile(path.join(repo, "tool.sh"), "#!/bin/sh\n");
    await fs.chmod(path.join(repo, "tool.sh"), 0o644);
    await fs.writeFile(path.join(repo, "image.png"), Buffer.from([0, 1, 2, 3]));
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "baseline");

    await fs.writeFile(path.join(repo, "text.txt"), "new line\ncontext");
    await fs.writeFile(path.join(repo, "new.ts"), "export const x = 1\n");
    await fs.rm(path.join(repo, "gone.md"));
    await fs.rename(path.join(repo, "old.md"), path.join(repo, "moved.md"));
    await fs.copyFile(path.join(repo, "copy-source.md"), path.join(repo, "copied.md"));
    await fs.writeFile(path.join(repo, "image.png"), Buffer.from([0, 9, 8, 7]));
    await fs.chmod(path.join(repo, "tool.sh"), 0o755);
    git(repo, "add", "-A");

    const diff = parseDiff(git(repo, "diff", "--cached", "--find-renames", "--find-copies-harder"));
    expect(
      diff.files.map((file) => [file.status, file.oldPath, file.newPath, file.isBinary]),
    ).toEqual([
      ["copied", "copy-source.md", "copied.md", false],
      ["removed", "gone.md", null, false],
      ["modified", "image.png", "image.png", true],
      ["renamed", "old.md", "moved.md", false],
      ["added", null, "new.ts", false],
      ["modified", "text.txt", "text.txt", false],
      ["modified", "tool.sh", "tool.sh", false],
    ]);
    const text = diff.files.find((file) => file.newPath === "text.txt")!;
    expect(text.hunks[0]!.lines).toEqual([
      { type: "del", oldNumber: 1, newNumber: null, content: "old line" },
      { type: "del", oldNumber: 2, newNumber: null, content: "context" },
      { type: "add", oldNumber: null, newNumber: 1, content: "new line" },
      { type: "add", oldNumber: null, newNumber: 2, content: "context" },
    ]);
    expect(text).toMatchObject({ additions: 2, deletions: 2, language: null });
    expect(diff.files.find((file) => file.newPath === "new.ts")!.language).toBe("typescript");
    expect(diff.files.find((file) => file.newPath === "tool.sh")!.mode).toBe(
      "old mode 100644; new mode 100755",
    );
  });
});
