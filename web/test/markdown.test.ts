import { describe, expect, it } from "vitest";
import { parseMarkdownLite } from "../src/lib/markdown";

/** Flatten a node tree to a compact shape for assertions (recursive). */
const shape = (nodes: ReturnType<typeof parseMarkdownLite>): string[] =>
  nodes.map((n) => {
    switch (n.kind) {
      case "text":
        return `text:${n.text}`;
      case "code":
        return `code:${n.text}`;
      case "link":
        return `link:${n.href}`;
      case "bold":
        return `bold(${shape(n.children).join("")})`;
      case "italic":
        return `italic(${shape(n.children).join("")})`;
    }
  });

describe("markdown-lite transform table", () => {
  it("plain text passes through untouched", () => {
    expect(shape(parseMarkdownLite("hello world"))).toEqual(["text:hello world"]);
  });

  it("**bold**", () => {
    expect(shape(parseMarkdownLite("hey **now**"))).toEqual([
      "text:hey ",
      "bold(text:now)",
    ]);
  });

  it("*italic*", () => {
    expect(shape(parseMarkdownLite("so *subtle*"))).toEqual([
      "text:so ",
      "italic(text:subtle)",
    ]);
  });

  it("`code` — literal, no nested parsing", () => {
    expect(shape(parseMarkdownLite("run `npm run **dev**` now"))).toEqual([
      "text:run ",
      "code:npm run **dev**",
      "text: now",
    ]);
  });

  it("bold wins over italic for ** pairs", () => {
    expect(shape(parseMarkdownLite("**bold** and *italic*"))).toEqual([
      "bold(text:bold)",
      "text: and ",
      "italic(text:italic)",
    ]);
  });

  it("unmatched markers stay literal text", () => {
    expect(shape(parseMarkdownLite("2 * 3 = 6 and a ** stray"))).toEqual([
      "text:2 * 3 = 6 and a ** stray",
    ]);
  });

  it("autolinks https URLs only, with trailing punctuation excluded", () => {
    expect(shape(parseMarkdownLite("see https://example.com/a?b=1."))).toEqual([
      "text:see ",
      "link:https://example.com/a?b=1",
      "text:.",
    ]);
  });

  it("http URLs link too; ftp/scheme-less stay text", () => {
    expect(shape(parseMarkdownLite("http://x.io ftp://y.io example.com"))).toEqual([
      "link:http://x.io",
      "text: ftp://y.io example.com",
    ]);
  });

  it("nested markers inside bold", () => {
    const nodes = parseMarkdownLite("**bold *and italic***");
    expect(nodes[0].kind).toBe("bold");
    if (nodes[0].kind === "bold") {
      expect(shape(nodes[0].children)).toEqual(["text:bold ", "italic(text:and italic)"]);
    }
  });

  it("empty string → no nodes", () => {
    expect(parseMarkdownLite("")).toEqual([]);
  });
});

describe("markdown-lite XSS table", () => {
  it("raw HTML renders as inert text nodes (React escapes it)", () => {
    const nodes = parseMarkdownLite("<script>alert(1)</script>");
    expect(nodes).toEqual([
      { kind: "text", text: "<script>alert(1)</script>" },
    ]);
  });

  it("<img onerror=...> stays text", () => {
    const nodes = parseMarkdownLite('<img src=x onerror="alert(1)">');
    expect(nodes.every((n) => n.kind === "text")).toBe(true);
  });

  it("javascript: URLs are NEVER autolinked", () => {
    expect(shape(parseMarkdownLite("javascript:alert(1)"))).toEqual([
      "text:javascript:alert(1)",
    ]);
  });

  it("java\nscript style tricks and data: URIs stay text", () => {
    for (const payload of ["data:text/html,<script>alert(1)</script>", "jAvascript:alert(1)"]) {
      const nodes = parseMarkdownLite(payload);
      expect(nodes.every((n) => n.kind === "text")).toBe(true);
    }
  });

  it("HTML inside a link-looking URL is not produced — URL regex excludes < and >", () => {
    const nodes = parseMarkdownLite("https://x.com/<script>");
    expect(nodes).toEqual([
      { kind: "link", href: "https://x.com/", text: "https://x.com/" },
      { kind: "text", text: "<script>" },
    ]);
  });

  it("markdown link syntax is not supported → literal text", () => {
    const nodes = parseMarkdownLite("[click](javascript:alert(1))");
    expect(nodes.every((n) => n.kind === "text")).toBe(true);
  });
});
