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
  onMedia?: (url: string, name?: string) => void;
};

function mediaName(url: string) {
  try {
    return decodeURIComponent(url.split("/").pop() || url);
  } catch {
    return url;
  }
}

export function MarkdownBody({ content, className = "", streaming, onMedia }: Props) {
  if (!content && !streaming) return null;

  return (
    <div className={`md-body ${className}`.trim()}>
      {content ? (
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ href, children }) => {
              const url = href || "";
              const name = mediaName(url);
              if (/\.(mp4|webm|mov|m4v)(\?|$)/i.test(url)) {
                return (
                  <video
                    className="md-video"
                    src={url}
                    controls
                    playsInline
                    onClick={() => onMedia?.(url, name)}
                  />
                );
              }
              if (/\.(mp3|wav|m4a|ogg)(\?|$)/i.test(url)) {
                return <audio className="md-audio" src={url} controls />;
              }
              if (/\.(pdf|docx?|xlsx?|pptx?)(\?|$)/i.test(url)) {
                return (
                  <button
                    type="button"
                    className="md-file-card"
                    onClick={() => (onMedia ? onMedia(url, name) : window.open(url, "_blank"))}
                  >
                    <span className="md-file-kind">{name.split(".").pop()}</span>
                    <span className="md-file-name">{name}</span>
                  </button>
                );
              }
              return (
                <a href={href} target="_blank" rel="noreferrer noopener">
                  {children}
                </a>
              );
            },
            img: ({ src, alt }) => {
              const url = src || "";
              return (
                <button
                  type="button"
                  className="md-img-btn"
                  onClick={() => onMedia?.(url, alt || mediaName(url))}
                >
                  <img className="md-img" src={url} alt={alt || ""} />
                </button>
              );
            },
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
