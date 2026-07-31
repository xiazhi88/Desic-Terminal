import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function AiMarkdown({ content }: { content: string }) {
  return (
    <div className="ai-markdown" data-i18n-skip>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          )
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
