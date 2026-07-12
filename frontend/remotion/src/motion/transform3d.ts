// transform3d — 요소 로컬 3D 회전.
// base.rotateX = 위아래 기울기(tilt), base.rotateY = 좌우 팬(pan). 도 단위.
// perspective() 를 회전 앞에 붙여 요소 단독으로 원근이 생기게 한다
// (씬 카메라의 rotateX/Y 와 독립 — 요소 자체의 3D 자세).

export type Rot3D = {
  rotateX?: number;
  rotateY?: number;
  /** 원근 강도(px). 작을수록 왜곡 큼. 기본 1100. */
  perspective?: number;
};

/** 요소 transform 체인에 끼울 3D 회전 조각. 회전 없으면 빈 문자열.
 *  noPerspective: 압출(extrude) 구조처럼 부모가 perspective "속성" 을 제공할 때
 *  — perspective() "함수" 는 자기 평면만 투영하고 preserve-3d 자식의 z 를
 *  투영하지 못한다 (실측: 72도 기울기에서 59px 스택이 7px 로 붕괴). */
export function rot3d(base: Rot3D | undefined, noPerspective?: boolean): string {
  const rx = base?.rotateX ?? 0;
  const ry = base?.rotateY ?? 0;
  if (rx === 0 && ry === 0) return "";
  const p = base?.perspective ?? 1100;
  const parts: string[] = noPerspective ? [] : [` perspective(${p}px)`];
  if (rx !== 0) parts.push(`rotateX(${rx}deg)`);
  if (ry !== 0) parts.push(`rotateY(${ry}deg)`);
  return " " + parts.join(" ").trim();
}
