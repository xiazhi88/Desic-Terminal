import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
// CommonMark 对 CJK 相邻加粗（**事实：**最新报价）的闭合分隔符判定会失败，此插件专门修复
import remarkCjkFriendly from "remark-cjk-friendly";

function safeHref(href: string | undefined) {
  if (!href) return undefined;
  const value = href.trim();
  if (/^(https?:|mailto:)/i.test(value)) return value;
  if (/^[/#?]/.test(value) && !value.startsWith("//")) return value;
  return undefined;
}

const components: Components = {
  a: ({ children, href, title }) => {
    const safe = safeHref(href);
    if (!safe) return <span className="ai-markdown-link-invalid">{children}</span>;
    const external = /^https?:/i.test(safe);
    return <a href={safe} title={title} target={external ? "_blank" : undefined} rel={external ? "noopener noreferrer" : undefined}>{children}</a>;
  },
  h1: ({ children }) => <h3>{children}</h3>,
  h2: ({ children }) => <h4>{children}</h4>,
  h3: ({ children }) => <h5>{children}</h5>,
  table: ({ children }) => <div className="ai-markdown-table-wrap"><table>{children}</table></div>,
  pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
  code: ({ children, className }) => {
    // AI 回答里的交易机会编号（opp + 时间戳 + 纳秒 + 后缀）：点一下跳到「交易机会」并选中它。
    const text = typeof children === "string" ? children.trim() : "";
    if (!className && /^opp\d{14,}[0-9a-f]{0,16}$/.test(text)) {
      return (
        <button
          type="button"
          className="ai-markdown-opportunity"
          title="在「交易机会」中打开"
          onClick={() => window.dispatchEvent(new CustomEvent("desic:open-trade-opportunity", { detail: { id: text } }))}
        >
          <code>{text}</code>
          <span aria-hidden="true">→ 交易机会</span>
        </button>
      );
    }
    return <code className={className}>{children}</code>;
  }
};

export function AiMarkdown({ content }: { content: string }) {
  return <div className="ai-markdown" data-i18n-skip><ReactMarkdown remarkPlugins={[remarkGfm, remarkCjkFriendly]} components={components}>{content}</ReactMarkdown></div>;
}

/** 运行摘要里模型常把 `## 标题` 挤在上一段同一行；标题前补空行，否则 markdown 不认它是标题。 */
export function normalizeRunMarkdown(value: string) {
  return value.replace(/\s+(#{1,6}\s+)/g, "\n\n$1").trim();
}
