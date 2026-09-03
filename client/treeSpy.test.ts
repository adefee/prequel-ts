import { describe, expect, test } from "bun:test";
import { pickActiveFileId } from "./treeSpy";

describe("pickActiveFileId", () => {
  test("returns null when nothing is visible", () => {
    expect(pickActiveFileId([], 80)).toBeNull();
    expect(pickActiveFileId([{ id: "a", top: 10, visible: false }], 80)).toBeNull();
  });

  test("picks the first visible file when all sit below the line", () => {
    expect(
      pickActiveFileId(
        [
          { id: "a", top: 120, visible: true },
          { id: "b", top: 800, visible: true },
        ],
        80,
      ),
    ).toBe("a");
  });

  test("picks the last file whose top has crossed the line", () => {
    expect(
      pickActiveFileId(
        [
          { id: "a", top: -40, visible: true },
          { id: "b", top: 20, visible: true },
          { id: "c", top: 400, visible: true },
        ],
        80,
      ),
    ).toBe("b");
  });

  test("skips hidden files (e.g. hidden tests)", () => {
    expect(
      pickActiveFileId(
        [
          { id: "test", top: 10, visible: false },
          { id: "src", top: 200, visible: true },
        ],
        80,
      ),
    ).toBe("src");
  });
});
