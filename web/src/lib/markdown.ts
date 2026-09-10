/**
 * Markdown-lite — the allowlist inline renderer for message bodies (PLAN
 * §Security/XSS). Supported syntax: **bold**, *italic*, `code` and bare
 * http(s) autolinks. Everything else — including raw HTML and non-http
 * link schemes — passes through as plain text.
 *
 * The transform is a PURE function returning a node tree (unit-tested in
 * web/test/markdown.test.ts, including the XSS payload table); the React
 * renderer below maps that tree to elements. There is no
 * dangerouslySetInnerHTML anywhere — React escapes every text node, so a
 * `<script>` payload can only ever render as visible text.
 */

export type InlineNode =
  | { kind: "text"; text: string }
  | { kind: "bold"; children: InlineNode[] }
  | { kind: "italic"; children: InlineNode[] }
  | { kind: "code"; text: string }
  | { kind: "link"; href: string; text: string };

/** Only http(s) URLs ever become links — `javascript:` etc. stay inert text. */
const URL_RE = /^https?:\/\/[^\s<>"]+/;

/** Trailing punctuation glued to a URL (e.g. "https://x.com.") is not part of it. */
const URL_TRAILING = /[.,!?;:)]+$/;

export function parseMarkdownLite(input: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let text = "";
  const flush = () => {
    if (text) {
      nodes.push({ kind: "text", text });
      text = "";
    }
  };

  let i = 0;
  while (i < input.length) {
    const ch = input[i];

    // `code` — literal span, no nested parsing inside.
    if (ch === "`") {
      const end = input.indexOf("`", i + 1);
      if (end !== -1) {
        flush();
        nodes.push({ kind: "code", text: input.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    // **bold** (checked before *italic*). Opening delimiter must not be
    // followed by whitespace — "2 ** 3" is arithmetic, not markup.
    if (ch === "*" && input[i + 1] === "*" && input[i + 2] !== " ") {
      let end = input.indexOf("**", i + 2);
      // Prefer the last asterisk of a closing run so "**a *b***" closes
      // AFTER the inner italic's own asterisk (CommonMark-style), and
      // end > i + 2 rules out empty ** pairs from adjacent delimiters.
      while (end !== -1 && input[end + 2] === "*") end += 1;
      if (end !== -1 && end > i + 2) {
        flush();
        nodes.push({ kind: "bold", children: parseMarkdownLite(input.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }

    // *italic* — same whitespace rule for the opening delimiter.
    if (ch === "*" && input[i + 1] !== " ") {
      const end = input.indexOf("*", i + 1);
      // end > i + 1: adjacent ** never forms an empty italic.
      if (end !== -1 && end > i + 1) {
        flush();
        nodes.push({ kind: "italic", children: parseMarkdownLite(input.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }

    // Autolink — only at a word boundary (start or after whitespace).
    if (ch === "h") {
      const match = URL_RE.exec(input.slice(i));
      if (match && (i === 0 || /\s/.test(input[i - 1]))) {
        let url = match[0];
        let trailing = "";
        const trimmed = url.replace(URL_TRAILING, (m) => {
          trailing = m;
          return "";
        });
        if (trimmed) {
          flush();
          nodes.push({ kind: "link", href: trimmed, text: trimmed });
          if (trailing) text += trailing;
          i += url.length;
          continue;
        }
        url = ""; // a bare "http://" with no host is plain text
      }
    }

    text += ch;
    i += 1;
  }
  flush();
  return nodes;
}
