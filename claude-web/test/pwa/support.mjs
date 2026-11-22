/** Shared helpers for the PWA artifact tests. */

/**
 * Remove block and whole-line `//` comments before asserting on forbidden
 * constructs: documentation is allowed to name `dangerouslySetInnerHTML` or
 * `Service-Worker-Allowed` while explaining that they are not used.
 */
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}
