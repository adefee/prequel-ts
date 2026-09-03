/** True when the path's basename is `*.test.<extension>` (no extra dots). */
export function isTestFile(filePath: string): boolean {
  const base = filePath.split("/").pop() ?? filePath;
  return /\.test\.[^./]+$/.test(base);
}

const STYLE_EXT = /\.(css|scss|sass|less|styl|stylus|pcss)$/i;

/** True when the path's basename is a stylesheet (css, scss, sass, less, …). */
export function isStyleFile(filePath: string): boolean {
  const base = filePath.split("/").pop() ?? filePath;
  return STYLE_EXT.test(base);
}

export function fileKindAttrs(filePath: string): string {
  return (
    (isTestFile(filePath) ? " data-test-file" : "") +
    (isStyleFile(filePath) ? " data-style-file" : "")
  );
}
