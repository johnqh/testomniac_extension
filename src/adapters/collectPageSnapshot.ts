/**
 * Runs INSIDE the page via chrome.scripting.executeScript. Must be fully
 * self-contained (no imports, no closure variables) so it serializes cleanly.
 * Collapses the previous separate content() + body-text injections into one
 * round trip.
 */
export function collectPageSnapshot(): {
  html: string;
  bodyTextLength: number;
} {
  const html = document.documentElement.outerHTML;
  const body = document.body;
  const text = body ? (body.innerText ?? body.textContent ?? '') : '';
  return { html, bodyTextLength: text.trim().length };
}
