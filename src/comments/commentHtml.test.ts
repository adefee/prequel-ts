import { expect, test } from "bun:test";
import { renderCommentHtml } from "./commentHtml";

test("comment HTML preserves safe markdown and removes executable markup", () => {
  const html = renderCommentHtml(
    "**ok** [safe](https://example.com) <script>x()</script> <img src=x onerror=boom> [bad](javascript:alert(1))",
  );
  expect(html).toContain("<strong>ok</strong>");
  expect(html).toContain('href="https://example.com"');
  expect(html).not.toContain("<script");
  expect(html).not.toContain("onerror");
  expect(html).not.toContain("javascript:");
});
