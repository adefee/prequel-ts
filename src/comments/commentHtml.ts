// Render comment markdown to HTML, then allowlist-sanitize it. The client
// interpolates bodyHtml as HTML, so this is the XSS boundary.

import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

marked.setOptions({ breaks: true });

const COMMENT_HTML = {
  allowedTags: [
    'p',
    'br',
    'blockquote',
    'pre',
    'code',
    'ul',
    'ol',
    'li',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'a',
    'strong',
    'b',
    'em',
    'i',
    's',
    'del',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
  ],
  allowedAttributes: {
    a: ['href'],
    code: ['class'],
    th: ['align'],
    td: ['align'],
  },
  allowedClasses: {
    code: [/^language-[\w-]+$/],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { a: ['http', 'https', 'mailto'] },
};

export function renderCommentHtml(body: string): string {
  return sanitizeHtml(marked.parse(body || '') as string, COMMENT_HTML);
}
