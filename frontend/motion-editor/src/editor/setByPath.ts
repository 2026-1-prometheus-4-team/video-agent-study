// setByPath.ts
// "props.perLetter.easing" 같은 점 경로로 중첩 객체를 읽고 쓴다. 인스펙터/이징이
// 레이어 props 를 갱신할 때 공용으로 쓴다 (immer draft 위에서 동작).

export function getByPath(obj: unknown, path: string): unknown {
  const parts = path.split(".").filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

// 경로 중간의 컨테이너가 없으면 만들며 내려간다. draft 에 대해 in-place 로 쓴다.
// 숫자 세그먼트("timeline.0.fill")는 배열 인덱스로 취급한다 — 기존 배열은 절대
// 덮어쓰지 않고 그 인덱스로 들어가며, 없으면 (다음 키가 숫자면) 배열을, 아니면
// 객체를 만든다. (버그 이력: 예전엔 Array.isArray 중간값을 {}로 덮어써서
// color.timeline 배열이 {0:{...}} 객체로 변해 엔진이 못 읽었다.)
export function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".").filter(Boolean);
  if (parts.length === 0) return;
  const isIndex = (s: string) => /^\d+$/.test(s);
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    const existing = cur[k];
    if (existing === null || typeof existing !== "object") {
      // 없으면 생성 — 다음 세그먼트가 숫자면 배열, 아니면 객체
      cur[k] = isIndex(parts[i + 1]) ? [] : {};
    }
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

// 경로의 최종 키를 지운다 (undefined 로 두는 게 아니라 delete).
export function deleteByPath(obj: Record<string, unknown>, path: string): void {
  const parts = path.split(".").filter(Boolean);
  if (parts.length === 0) return;
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cur[parts[i]];
    if (next === null || typeof next !== "object") return;
    cur = next as Record<string, unknown>;
  }
  delete cur[parts[parts.length - 1]];
}
