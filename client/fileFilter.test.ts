import { describe, expect, test } from "bun:test";
import { fileIsVisible, isStyleFile, isTestFile, normalizeQuery, pathMatches } from "./fileFilter";

describe("isTestFile", () => {
  test("matches basename ending in .test.<extension>", () => {
    expect(isTestFile("foo.test.ts")).toBe(true);
    expect(isTestFile("foo.test.js")).toBe(true);
    expect(isTestFile("foo.test.tsx")).toBe(true);
    expect(isTestFile("src/git/prConfig.test.ts")).toBe(true);
  });

  test("rejects non-test names", () => {
    expect(isTestFile("foo.ts")).toBe(false);
    expect(isTestFile("foo.spec.ts")).toBe(false);
    expect(isTestFile("test.ts")).toBe(false);
    expect(isTestFile("foo.tests.ts")).toBe(false);
    expect(isTestFile("foo.test")).toBe(false);
    expect(isTestFile("foo.test.")).toBe(false);
    expect(isTestFile("dir.test.ts/file.ts")).toBe(false);
    expect(isTestFile("foo.test.d.ts")).toBe(false);
  });
});

describe("isStyleFile", () => {
  test("matches stylesheet extensions", () => {
    expect(isStyleFile("public/css/diff.css")).toBe(true);
    expect(isStyleFile("src/app.scss")).toBe(true);
    expect(isStyleFile("src/app.sass")).toBe(true);
    expect(isStyleFile("src/app.less")).toBe(true);
    expect(isStyleFile("src/app.styl")).toBe(true);
    expect(isStyleFile("src/app.module.css")).toBe(true);
    expect(isStyleFile("Theme.CSS")).toBe(true);
  });

  test("rejects non-style names", () => {
    expect(isStyleFile("src/app.ts")).toBe(false);
    expect(isStyleFile("tokens.css.ts")).toBe(false);
    expect(isStyleFile("diff.css.map")).toBe(false);
    expect(isStyleFile("styles/css/readme.md")).toBe(false);
  });
});

describe("fileIsVisible", () => {
  test("hides test files only when the toggle is on", () => {
    expect(fileIsVisible("src/a.test.ts", "", {})).toBe(true);
    expect(fileIsVisible("src/a.test.ts", "", { hideTestFiles: true })).toBe(false);
    expect(fileIsVisible("src/a.ts", "", { hideTestFiles: true })).toBe(true);
  });

  test("hides style files only when the toggle is on", () => {
    expect(fileIsVisible("src/a.css", "", {})).toBe(true);
    expect(fileIsVisible("src/a.css", "", { hideStyleFiles: true })).toBe(false);
    expect(fileIsVisible("src/a.ts", "", { hideStyleFiles: true })).toBe(true);
    expect(fileIsVisible("src/a.test.ts", "", { hideStyleFiles: true })).toBe(true);
  });

  test("still applies the path query to remaining files", () => {
    expect(fileIsVisible("src/a.ts", "src/", { hideTestFiles: true })).toBe(true);
    expect(fileIsVisible("lib/a.ts", "src/", { hideTestFiles: true })).toBe(false);
    expect(fileIsVisible("src/a.test.ts", "src/", { hideTestFiles: true })).toBe(false);
    expect(fileIsVisible("src/a.css", "src/", { hideStyleFiles: true })).toBe(false);
  });
});

describe("pathMatches", () => {
  test("substring match is case-insensitive", () => {
    expect(pathMatches("Src/Foo.ts", "foo")).toBe(true);
    expect(pathMatches("Src/Foo.ts", "  FOO  ")).toBe(true);
    expect(pathMatches("Src/Foo.ts", "bar")).toBe(false);
    expect(pathMatches("Src/Foo.ts", "")).toBe(true);
    expect(normalizeQuery("  Foo  ")).toBe("foo");
  });
});
