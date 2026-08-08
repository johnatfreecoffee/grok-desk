/**
 * High-fidelity markdown for assistant (and optional user) bubbles.
 * GFM tables/lists, fenced code with copy, inline code, links.
 */
import { useCallback, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { copyTextToClipboard } from "../lib/clipboard";

function CodeBlock({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const text = String(children ?? "").replace(/\n$/, "");
  const lang = /language-([\w-]+)/.exec(className || "")?.[1] || "";

  const onCopy = useCallback(async () => {
    const ok = await copyTextToClipboard(text);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    }
  }, [text]);

  // Inline code (no language, single line) vs fenced block
  const isBlock = Boolean(lang) || text.includes("\n");
  if (!isBlock) {
    return <code className="md-inline-code">{text}</code>;
  }

  return (
    <div className="md-code-wrap">
      <div className="md-code-bar">
        <span className="md-code-lang">{lang || "code"}</span>
        <button type="button" className="md-code-copy" onClick={() => void onCopy()}>
          {copied ? <Check size={12} strokeWidth={2.5} /> : <Copy size={12} strokeWidth={2} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="md-code-pre">
        <code className={className}>{text}</code>
      </pre>
    </div>
  );
}

type Props = {
  content: string;
  className?: string;
  /** Show streaming caret after content */
  streaming?: boolean;
};

export function MarkdownBody({ content, className = "", streaming }: Props) {
  if (!content && !streaming) return null;

  return (
    <div className={`md-body ${className}`.trim()}>
      {content ? (
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ href, children }) => (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            ),
            code: ({ className: cn, children }) => (
              <CodeBlock className={cn}>{children}</CodeBlock>
            ),
            pre: ({ children }) => <>{children}</>,
            table: ({ children }) => (
              <div className="md-table-wrap">
                <table>{children}</table>
              </div>
            ),
          }}
        >
          {content}
        </ReactMarkdown>
      ) : null}
      {streaming ? <span className="caret" /> : null}
    </div>
  );
}
