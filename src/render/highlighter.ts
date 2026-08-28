// Syntax highlighting via Shiki, using GitHub's own TextMate themes so colors
// match GitHub. Dual-theme output: each token carries a light color plus a
// `--shiki-dark` custom property; diff.css swaps to the dark var in dark mode.
//
// Highlighting is hunk-local: within each hunk we reconstruct the old side
// (context+deletions) and new side (context+additions) and tokenize each, then
// map the per-line HTML back onto the diff lines. This is multi-line aware
// within a hunk without needing to read whole files. (Constructs opened before
// a hunk — e.g. a block comment — aren't known; acceptable for now.)
//
// It also overlays word-level (intra-line) diff highlighting: changed character
// ranges (from wordDiff.ts, on line.wordRanges) get an extra `wd` class.

import { createHighlighter } from 'shiki';
import type { BundledLanguage, Highlighter } from 'shiki';
import type { CharRange, RenderDiff } from './renderer';

const THEMES = { light: 'github-light', dark: 'github-dark' } as const;

/**
 * The slice of a Shiki token this module needs. Declared locally so the render
 * code doesn't depend on Shiki's generic token shape.
 */
interface Token {
  content: string;
  htmlStyle?: Record<string, string> | null;
}

let highlighterPromise: Promise<Highlighter> | null = null;
const loadedLangs = new Set<string>();

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [THEMES.light, THEMES.dark],
      langs: [],
    });
  }
  return highlighterPromise;
}

async function ensureLang(hl: Highlighter, lang: string | null): Promise<boolean> {
  if (!lang) return false;
  if (loadedLangs.has(lang)) return true;
  try {
    await hl.loadLanguage(lang as BundledLanguage);
    loadedLangs.add(lang);
    return true;
  } catch {
    return false; // unknown/unsupported language — fall back to plain text
  }
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Bounded cache of tokenized text -> array of token-lines.
const cache = new Map<string, Token[][]>();
const CACHE_MAX = 800;

function tokenStyle(tok: Token): string {
  return tok.htmlStyle
    ? `color:${tok.htmlStyle['color']};--shiki-dark:${tok.htmlStyle['--shiki-dark']}`
    : '';
}

// Emit a token's content, splitting at word-diff range boundaries so changed
// segments get the extra `wd` (word-diff) class. `base` is the token's char
// offset within its line; `ranges` are [start,end) changed spans for the line.
function tokenToHtml(tok: Token, base: number, ranges: CharRange[] | null): string {
  const style = tokenStyle(tok);
  const content = tok.content;
  if (!ranges || ranges.length === 0) {
    return `<span class="tok" style="${style}">${escapeHtml(content)}</span>`;
  }
  const inRange = (abs: number) => ranges.some(([s, e]) => abs >= s && abs < e);
  let out = '';
  let i = 0;
  while (i < content.length) {
    const changed = inRange(base + i);
    let j = i + 1;
    while (j < content.length && inRange(base + j) === changed) j++;
    const cls = changed ? 'tok wd' : 'tok';
    out += `<span class="${cls}" style="${style}">${escapeHtml(content.slice(i, j))}</span>`;
    i = j;
  }
  return out;
}

// Assemble one line's HTML from its tokens, applying word-diff ranges.
function assembleLine(lineTokens: Token[] | undefined, ranges: CharRange[] | null): string {
  if (!lineTokens) return '';
  let html = '';
  let pos = 0;
  for (const tok of lineTokens) {
    html += tokenToHtml(tok, pos, ranges);
    pos += tok.content.length;
  }
  return html;
}

function plainTokenLines(text: string): Token[][] {
  return text.split('\n').map((l) => (l === '' ? [] : [{ content: l, htmlStyle: null }]));
}

// Cached tokenization: text -> array of token-lines (each token has content +
// htmlStyle). Falls back to plain single-token lines if Shiki can't tokenize.
function tokensForText(hl: Highlighter, text: string, lang: string): Token[][] {
  const key = lang + ' ' + text;
  const hit = cache.get(key);
  if (hit) return hit;
  let perLine: Token[][];
  try {
    perLine = hl.codeToTokens(text, { lang: lang as BundledLanguage, themes: THEMES })
      .tokens as unknown as Token[][];
  } catch {
    perLine = plainTokenLines(text);
  }
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, perLine);
  return perLine;
}

// Highlight a plain array of lines (used for on-demand context expansion).
// Returns an array of per-line HTML, or null if the language isn't available.
export async function highlightLines(
  lines: string[],
  lang: string | null
): Promise<string[] | null> {
  if (!lang) return null;
  const hl = await getHighlighter();
  if (!(await ensureLang(hl, lang))) return null;
  return tokensForText(hl, lines.join('\n'), lang).map((tl) => assembleLine(tl, null));
}

// Returns a render projection with pre-rendered `line.html` on code lines.
// Combines Shiki syntax tokens with word-diff ranges so both layers render
// together. Word highlighting applies even when there's no language.
export async function highlightDiff(input: RenderDiff): Promise<RenderDiff> {
  const diff: RenderDiff = {
    ...input,
    files: input.files.map((file) => ({
      ...file,
      hunks: file.hunks.map((hunk) => ({
        ...hunk,
        lines: hunk.lines.map((line) => ({ ...line })),
      })),
    })),
  };
  const langs = [...new Set(diff.files.map((f) => f.language).filter((l): l is string => Boolean(l)))];
  let hl: Highlighter | null = null;
  const usable = new Set<string>();
  if (langs.length) {
    hl = await getHighlighter();
    await Promise.all(langs.map(async (l) => (await ensureLang(hl!, l)) && usable.add(l)));
  }

  for (const file of diff.files) {
    if (file.isBinary) continue;
    const lang = file.language && usable.has(file.language) ? file.language : null;
    for (const hunk of file.hunks) {
      const newText = hunk.lines
        .filter((l) => l.type === 'context' || l.type === 'add')
        .map((l) => l.content)
        .join('\n');
      const oldText = hunk.lines
        .filter((l) => l.type === 'context' || l.type === 'del')
        .map((l) => l.content)
        .join('\n');
      const newTokens = lang && hl ? tokensForText(hl, newText, lang) : plainTokenLines(newText);
      const oldTokens = lang && hl ? tokensForText(hl, oldText, lang) : plainTokenLines(oldText);

      let ni = 0;
      let oi = 0;
      for (const line of hunk.lines) {
        const tokens = line.type === 'del' ? oldTokens[oi] : newTokens[ni];
        // Render html when there's something beyond plain text: syntax colors
        // (lang) or word-diff ranges.
        if (lang || (line.wordRanges && line.wordRanges.length)) {
          line.html = assembleLine(tokens, line.wordRanges ?? null);
        }
        if (line.type === 'context') {
          ni++;
          oi++;
        } else if (line.type === 'add') {
          ni++;
        } else {
          oi++;
        }
      }
    }
  }
  return diff;
}
