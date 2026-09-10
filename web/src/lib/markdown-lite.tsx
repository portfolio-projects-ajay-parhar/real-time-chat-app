import type { ReactNode } from "react";
import { parseMarkdownLite, type InlineNode } from "./markdown";

function renderNode(node: InlineNode, key: number): ReactNode {
  switch (node.kind) {
    case "text":
      return <span key={key}>{node.text}</span>;
    case "bold":
      return <strong key={key}>{node.children.map((c, i) => renderNode(c, i))}</strong>;
    case "italic":
      return <em key={key}>{node.children.map((c, i) => renderNode(c, i))}</em>;
    case "code":
      return (
        <code
          key={key}
          className="rounded bg-black/30 px-1 py-0.5 font-mono text-[0.85em] break-all"
        >
          {node.text}
        </code>
      );
    case "link":
      return (
        <a
          key={key}
          href={node.href}
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 hover:opacity-80"
        >
          {node.text}
        </a>
      );
  }
}

/**
 * Message-body renderer: markdown-lite to React elements, allowlist-only.
 * Never renders raw HTML — XSS payloads come out as escaped text.
 */
export function MarkdownLite({ text }: { text: string }) {
  const nodes = parseMarkdownLite(text);
  return (
    <>
      {nodes.map((node, i) => renderNode(node, i))}
    </>
  );
}
