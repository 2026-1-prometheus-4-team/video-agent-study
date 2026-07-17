"use client";

import { Children, isValidElement } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { useAgentStore } from "./state";
import { formatSeconds } from "@/lib/format";
import styles from "./markdown.module.css";

// ---------- 타임스탬프 링크화 ----------
//
// 에이전트 텍스트의 `1:23`, `0:05.5`, `12.3s`, `12초`, `1분 23초` 패턴을
// 클릭 가능한 칩으로 변환 → requestSeek. 텍스트 노드만 처리하므로
// 코드블록(<code>)·링크(<a>) 내부는 자연히 제외됨 (해당 컴포넌트에서
// linkify 를 적용하지 않음).

// 쇼츠 제품이라 에이전트가 화면비(9:16)를 상시 언급한다 — mm:ss 로 오인해 칩을
// 만들면 엉뚱한 시킹이 되므로 흔한 화면비 쌍은 선제 배제. 뒤에 숫자/콜론이 더
// 붙으면 (1:10 등) 화면비가 아니므로 통과시킨다.
const ASPECT_RATIO_ALT = "9:16|16:9|4:3|1:1|21:9";

const TS_RE = new RegExp(
  // 앞 가드: 식별자·시각 조각(\w :) · URL/경로 · 버전(.) · 금액($) 뒤엔 매치 금지.
  //   ex.com/12s · v1.2.3s · $2.5s
  "(?<![\\w:./$])" +
    `(?!(?:${ASPECT_RATIO_ALT})(?![\\d:.]))` +
    "(?:" +
    // 1:23 · 12:34:56 · 0:05.5
    "\\d{1,3}:[0-5]?\\d(?::[0-5]\\d)?(?:\\.\\d{1,2})?" +
    // 1분 23초 (초 생략 불가 — "5분짜리" 류 오탐 방지)
    "|\\d+\\s*분\\s*\\d{1,2}(?:\\.\\d+)?\\s*초" +
    // 12초 · 12.5초
    "|\\d+(?:\\.\\d+)?\\s*초" +
    // 12.3s
    "|\\d+(?:\\.\\d+)?s" +
    ")" +
    // 뒤 가드: 식별자·시각 조각 금지 + 배속/배수 단위 문맥 금지 (1.2s 배속 · 2s x3).
    // \w 는 한글을 포함하지 않아 후행 가드만으론 "배속" 을 못 막는다 — 명시적으로.
    "(?![\\w:])(?!\\s*배속)(?!\\s*[xX]\\s*\\d)",
  "g"
);

/** 매치 문자열 → 초. 파싱 실패 시 null. */
function parseTimestamp(raw: string): number | null {
  const s = raw.trim();
  let m = s.match(/^(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?(?:\.(\d{1,2}))?$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const c = m[3] !== undefined ? Number(m[3]) : null;
    const frac = m[4] !== undefined ? Number(`0.${m[4]}`) : 0;
    return c !== null ? a * 3600 + b * 60 + c + frac : a * 60 + b + frac;
  }
  m = s.match(/^(\d+)\s*분\s*(\d{1,2}(?:\.\d+)?)\s*초$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = s.match(/^(\d+(?:\.\d+)?)\s*초$/);
  if (m) return Number(m[1]);
  m = s.match(/^(\d+(?:\.\d+)?)s$/);
  if (m) return Number(m[1]);
  return null;
}

/**
 * 타임스탬프 칩 클릭 → 원본 기준 시킹.
 *
 * 에이전트 텍스트의 타임스탬프는 원본(source) 기준인데 Stage 는 final 도착 시
 * 자동으로 편집본으로 전환된다. 그대로 시킹하면 편집본에 원본 좌표가 적용돼
 * 엉뚱한 지점으로 간다 — ClarifyCard 후보 칩과 동일하게 원본으로 전환 후 시킹.
 */
function seekSource(target: number) {
  const store = useAgentStore.getState();
  if (store.stageViewMode !== "source") {
    store.setStageViewMode("source");
  }
  store.requestSeek(target);
}

function linkifyString(text: string, keyBase: string): React.ReactNode {
  TS_RE.lastIndex = 0;
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = TS_RE.exec(text)) !== null) {
    const sec = parseTimestamp(m[0]);
    if (sec === null || !Number.isFinite(sec)) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    const label = m[0];
    const target = sec;
    out.push(
      <button
        key={`${keyBase}-ts-${i++}`}
        type="button"
        className={styles.tsChip}
        title={`${formatSeconds(target)} 지점으로 이동`}
        onClick={() => seekSource(target)}
      >
        {label}
      </button>
    );
    last = m.index + m[0].length;
  }
  if (out.length === 0) return text; // 매치 없음 — 원본 그대로
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** children 중 문자열 노드만 타임스탬프 칩으로 변환. 엘리먼트는 그대로 통과. */
function linkifyChildren(children: React.ReactNode): React.ReactNode {
  return Children.map(children, (child, idx) => {
    if (typeof child === "string") return linkifyString(child, `c${idx}`);
    if (isValidElement(child)) return child;
    return child;
  });
}

const COMPONENTS: Components = {
  // paragraph — 여백 최소, 마지막 단락은 margin 0
  p({ children }) {
    return <p className={styles.p}>{linkifyChildren(children)}</p>;
  },
  strong({ children }) {
    return (
      <strong className={styles.strong}>{linkifyChildren(children)}</strong>
    );
  },
  em({ children }) {
    return <em className={styles.em}>{linkifyChildren(children)}</em>;
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
    return <li className={styles.li}>{linkifyChildren(children)}</li>;
  },
  h1({ children }) {
    return <h3 className={styles.h1}>{linkifyChildren(children)}</h3>;
  },
  h2({ children }) {
    return <h4 className={styles.h2}>{linkifyChildren(children)}</h4>;
  },
  h3({ children }) {
    return <h5 className={styles.h3}>{linkifyChildren(children)}</h5>;
  },
  h4({ children }) {
    return <h6 className={styles.h4}>{linkifyChildren(children)}</h6>;
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
    return <th className={styles.th}>{linkifyChildren(children)}</th>;
  },
  td({ children }) {
    return <td className={styles.td}>{linkifyChildren(children)}</td>;
  },
};

/**
 * agent · tool_result · critic note 등 텍스트를 마크다운으로 렌더.
 *
 * - GFM (표, 취소선, 태스크 리스트) 지원
 * - 코드 블록: 라이트한 단일-색 스타일 (highlight.js 는 번들 사이즈 너무 큼)
 * - 타임스탬프 (`1:23` · `12초` · `1분 23초` · `12.3s`) 는 클릭 시 해당 지점
 *   으로 시킹하는 칩으로 렌더 (코드블록·링크 내부 제외)
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
