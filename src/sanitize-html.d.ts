declare module "sanitize-html" {
  interface SanitizeOptions {
    allowedTags?: string[];
    allowedAttributes?: Record<string, string[]>;
    allowedClasses?: Record<string, Array<string | RegExp>>;
    allowedSchemes?: string[];
    allowedSchemesByTag?: Record<string, string[]>;
  }
  function sanitizeHtml(dirty: string, options?: SanitizeOptions): string;
  export default sanitizeHtml;
}
