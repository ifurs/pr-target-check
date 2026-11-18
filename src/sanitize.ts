// Workflow files, step names and API fields come from repositories the user may not control.
// Nothing from them may reach the terminal as control characters, break out of the shell
// command we print, or turn into links or HTML in a Markdown report.

// Control characters (C0 except tab and newline, DEL, C1, so no ESC sequences), Unicode line
// separators and bidi overrides. Code points, so no invisible characters live in this file.
const UNSAFE: [number, number][] = [
  [0x00, 0x08],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];
const REPLACEMENT = String.fromCodePoint(0xfffd);
const ELLIPSIS = String.fromCodePoint(0x2026);

/** Replaces control characters (including ESC, so no terminal escape sequences) and caps length. */
export function clean(s: string, max = 300): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    out += UNSAFE.some(([a, b]) => c >= a && c <= b) ? REPLACEMENT : ch;
  }
  return out.length > max ? out.slice(0, max) + ELLIPSIS : out;
}

/** Quotes a string for POSIX shells: 'it'\''s'. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Escapes text so Markdown renders it literally (no links, images, HTML or emphasis). */
export function mdText(s: string): string {
  return clean(s).replace(/[\\`*_{}[\]<>()#+!|~]/g, "\\$&").replace(/\n/g, " ");
}

/** A value shown inside an inline code span. */
export function mdCode(s: string): string {
  return "`" + clean(s).replace(/`/g, "'").replace(/\n/g, " ") + "`";
}
