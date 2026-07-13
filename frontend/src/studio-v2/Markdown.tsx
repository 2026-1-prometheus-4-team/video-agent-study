"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import styles from "./markdown.module.css";

const COMPONENTS: Components = {
  // paragraph — 여백 최소, 마지막 단락은 margin 0
  p({ children }) {
    return <p className={styles.p}>{children}</p>;
  },
  strong({ children }) {
    return <strong className={styles.strong}>{children}</strong>;
  },
  em({ children }) {
    return <em className={styles.em}>{children}</em>;
  },
  a({ href, children }) {
    return (
      <a
        className={styles.a}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
    );
  },
  ul({ children }) {
    return <ul className={styles.ul}>{children}</ul>;
  },
  ol({ children }) {
    return <ol className={styles.ol}>{children}</ol>;
  },
  li({ children }) {
    return <li className={styles.li}>{children}</li>;
  },
  h1({ children }) {
    return <h3 className={styles.h1}>{children}</h3>;
  },
  h2({ children }) {
    return <h4 className={styles.h2}>{children}</h4>;
  },
  h3({ children }) {
    return <h5 className={styles.h3}>{children}</h5>;
  },
  h4({ children }) {
    return <h6 className={styles.h4}>{children}</h6>;
  },
  blockquote({ children }) {
    return <blockquote className={styles.quote}>{children}</blockquote>;
  },
  hr() {
    return <hr className={styles.hr} />;
  },
  code(props) {
    const { className, children, ...rest } = props as {
      className?: string;
      children?: React.ReactNode;
      inline?: boolean;
    };
    // react-markdown 은 inline prop 을 안 주므로 className 유무로 구분
    // fenced code (```lang ... ```) 는 className="language-lang" 가짐.
    const isBlock = /language-/.test(className || "");
    if (isBlock) {
      const lang = /language-(\w+)/.exec(className || "")?.[1];
      return (
        <div className={styles.codeBlockWrap}>
          {lang && <div className={styles.codeLang}>{lang}</div>}
          <pre className={styles.codeBlock}>
            <code {...rest}>{children}</code>
          </pre>
        </div>
      );
    }
    return (
      <code className={styles.codeInline} {...rest}>
        {children}
      </code>
    );
  },
  pre({ children }) {
    // 이미 code 컴포넌트에서 <pre> 로 감싸므로, 여기선 그대로 통과.
    return <>{children}</>;
  },
  table({ children }) {
    return (
      <div className={styles.tableWrap}>
        <table className={styles.table}>{children}</table>
      </div>
    );
  },
  th({ children }) {
    return <th className={styles.th}>{children}</th>;
  },
  td({ children }) {
    return <td className={styles.td}>{children}</td>;
  },
};

/**
 * agent · tool_result · critic note 등 텍스트를 마크다운으로 렌더.
 *
 * - GFM (표, 취소선, 태스크 리스트) 지원
 * - 코드 블록: 라이트한 단일-색 스타일 (highlight.js 는 번들 사이즈 너무 큼)
 * - 스트리밍 중이면 뒤에 caret 추가 (선택)
 */
export function Markdown({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <div className={`${styles.wrap} ${className ?? ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
