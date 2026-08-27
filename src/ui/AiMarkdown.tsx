import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

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
  code: ({ children, className }) => <code className={className}>{children}</code>
};

export function AiMarkdown({ content }: { content: string }) {
  return <div className="ai-markdown" data-i18n-skip><ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{content}</ReactMarkdown></div>;
}
