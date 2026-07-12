// structural/statReveal.tsx
// "Stat reveal" — 강조 숫자가 카운트업하며 안착하고, 도달 순간 색이 물들었다
// 빠지며, 뒤에 라벨(suffix)이 characters-settle 스타일로 한 글자씩 등장하는
// 복합 리빌. number_counter 를 건드리지 않고 별도 아톰으로 일반화한다.
//
// 레이아웃(ComposedText 렌더): [prefix + 숫자][suffix] 한 줄. suffix 는 폭을
// 미리 확보(reserved)하고, 그룹 translateX 로 처음엔 숫자를 화면 중앙에,
// 점점 왼쪽으로 밀어 suffix 자리를 낸다. easeOutBack 이라 왼쪽으로 살짝
// 오버슈트했다 오른쪽으로 튕겨 안착(= "밀렸다 다시 오는" 바운스).
//
// phase (로컬프레임):
//   0..countDuration           숫자 count(easeOut) + scale settle(scaleFrom->1,
//                              settleFrac*count 지점에 이미 안착) . 색=baseColor.
//   countDuration              도달. 색이 landColor 로 물듦.
//   countDuration..+drain      색이 landColor -> baseColor 로 빠짐(easeInOut).
//   countDuration+suffixDelay..  suffix 글자별 stagger 등장(characters-settle:
//                              scale/opacity/blur easeOut + rotate easeOutBack
//                              오버슈트 바운스). 동시에 그룹이 왼쪽으로 슬라이드.

import {
  clamp,
  clamp01,
  EASING,
  lerp,
  resolveEasing,
} from "../core/easing";
import { mixHex } from "../color/engine";

export type StatRevealProps = {
  prefix?: string; // 숫자 앞 고정 문자(카운팅 안 함), 예 "+"
  from?: number;
  to?: number;
  suffix?: string; // 숫자 뒤 라벨(카운팅 안 함, 글자별 등장), 예 "ATMS"
  // suffix 표시 방식. "reveal"(기본)=글자별 characters 등장 + 좌측 슬라이드
  // 쇼케이스. "static"=그냥 붙어있는 단위(kW, %) — 애니/슬라이드 없는 평범
  // 카운터. number_counter 를 완전히 대체하기 위한 모드.
  suffixMode?: "reveal" | "static";
  decimals?: number;
  thousands?: boolean;
  // 숫자 슬롯 내 정렬 = 빈자리가 생기는 쪽을 결정. 자릿수가 줄어도 affix("+")
  // 는 안 밀리고 반대편이 빈다. "left"(기본): 왼쪽 prefix 에 붙고 오른쪽이 빔.
  // "right": 오른쪽 affix 에 붙고 왼쪽이 빔. "center": 가운데.
  digitsAlign?: "left" | "right" | "center";
  // affix(prefix) 위치. "left"(기본) 숫자 앞(+55), "right" 숫자 뒤(55%).
  prefixSide?: "left" | "right";

  countDuration?: number; // 카운트 프레임 수
  countEasing?: string; // 기본 easeOut. named 또는 "cubic(...)" (에디터 커스텀 cubic() 지원)

  baseColor?: string; // 최종 색(검정 계열)
  landColor?: string; // 도달 순간 물드는 색(빨강 계열)
  colorDrainDur?: number; // landColor -> baseColor 로 빠지는 프레임 수

  // 숫자 scale settle: scaleFrom 에서 시작해 settleFrac*countDuration 지점에서
  // 1 로 안착(easeOut). "살짝 커졌다 원래 크기로".
  scaleFrom?: number;
  settleFrac?: number; // 0..1
  // 착지 순간 통 튀는 바운스 진폭(0=off). 숫자만 나올 때의 메인 악센트.
  landBounce?: number;

  // suffix 폰트 크기(숫자 대비 배율). 숫자를 강조하려고 suffix 는 작게.
  suffixScale?: number;
  // 숫자와 suffix 사이 간격(숫자 fontSize em). 아주 작게.
  suffixGap?: number;

  // suffix 리빌(characters-settle). countDuration 뒤 suffixDelay 부터 stagger.
  suffixDelay?: number;
  suffixStagger?: number;
  suffixSettleDur?: number;
  suffixScaleFrom?: number;
  suffixRotateFrom?: number; // deg
  suffixBlurFrom?: number; // suffix em 단위

  // 그룹 슬라이드(숫자가 왼쪽으로 자리 내주는 이동) 시작 지연.
  slideDelay?: number;
  // 슬라이드 자체 길이(프레임). 지정하면 suffix 창과 무관하게 이 길이로.
  // 짧을수록 왼쪽으로 "팍" 스냅. 미지정이면 suffix 리빌 창에 맞춘다.
  slideDuration?: number;
  slideExtra?: number; // (미지정 시) 슬라이드 창을 suffix 창보다 더 늘릴 때
  // 슬라이드 곡선. 기본 easeOutBack(1회 오버슈트). "springOut" 이면 통통
  // 튀는 뽀잉/또잉 바운스. named 또는 "cubic(...)" (에디터 커스텀 cubic() 지원).
  slideEasing?: string;
};

const FORMATTERS = new Map<string, Intl.NumberFormat>();
function getFormatter(decimals: number, thousands: boolean): Intl.NumberFormat {
  const key = `${decimals}|${thousands}`;
  const cached = FORMATTERS.get(key);
  if (cached) return cached;
  const fmt = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: thousands,
  });
  FORMATTERS.set(key, fmt);
  return fmt;
}

export type StatRevealLetter = {
  ch: string;
  opacity: number;
  scale: number;
  rotateDeg: number;
  blurEm: number; // suffix em 단위(ComposedText 에서 px 로 변환)
};

export type StatRevealFrame = {
  prefix: string;
  digits: string;
  // 숫자 슬롯 폭 확보용(최댓값 문자열). 카운트 중 자릿수 증가로 폭이 튀지
  // 않게 ComposedText 가 이 문자열 폭으로 슬롯을 고정한다.
  reserveText: string;
  // prefix 제외한 숫자만의 폭 확보용 = format(to). 이 폭으로 숫자 슬롯을
  // 고정하면 자릿수/글리프 폭이 바뀌어도 prefix("+")가 안 흔들린다.
  digitsReserve: string;
  numberScale: number;
  numberColor: string;
  // 그룹 좌측 슬라이드 진행도. groupShiftPx = (1 - slideEased) * suffix폭/2.
  // easeOutBack 이라 1 을 넘겼다(오버슈트) 돌아온다 -> 바운스.
  slideEased: number;
  suffix: StatRevealLetter[];
};

export function statRevealState(
  local: number,
  p: StatRevealProps,
): StatRevealFrame {
  const from = p.from ?? 0;
  const to = p.to ?? 100;
  const countDur = clamp(p.countDuration ?? 40, 1, 240);
  // 에디터 커스텀 cubic() 지원 — named 는 기존과 동일하게 해석된다
  const countEase = resolveEasing(p.countEasing, "easeOut");
  const decimals = clamp(p.decimals ?? 0, 0, 6);
  const thousands = p.thousands !== false;
  const prefix = p.prefix ?? "";
  const baseColor = p.baseColor ?? "#111111";
  const landColor = p.landColor ?? "#E23B3B";

  // 카운트 값
  const ct = clamp01(local / countDur);
  const value = lerp(from, to, countEase(ct));
  const fmt = getFormatter(decimals, thousands);
  const digits = fmt.format(value);
  const reserveText = prefix + fmt.format(to);

  // "정말 to 되는 순간" 앵커: easeOut 이면 표시값이 countDur 이전에 이미 to 로
  // 반올림된다. 표시값이 처음 to 로 반올림되는 프레임을 찾아 색/슬라이드/suffix
  // 를 그 순간에 맞춘다(색이 55 되는 순간과 정확히 일치).
  const toText = fmt.format(to);
  let landLocal = countDur;
  for (let f = 0; f <= countDur; f++) {
    if (fmt.format(lerp(from, to, countEase(clamp01(f / countDur)))) === toText) {
      landLocal = f;
      break;
    }
  }

  // scale settle
  const scaleFrom = clamp(p.scaleFrom ?? 1.28, 0.3, 4);
  const settleFrac = clamp01(p.settleFrac ?? 0.35);
  const settleDur = Math.max(1, settleFrac * countDur);
  // easeInOut: 앞쏠림 없이 천천히 균일하게 축소(easeOut 은 초반에 확 작아짐).
  let numberScale = lerp(scaleFrom, 1, EASING.easeInOut(clamp01(local / settleDur)));
  // 착지 바운스: 숫자가 to 에 닿는 순간(landLocal) 통 튀었다 springOut 으로
  // 안착. 숫자만 나올 때(suffix 없어 슬라이드가 없을 때)의 메인 악센트.
  const landBounce = clamp(p.landBounce ?? 0.12, 0, 1);
  const bounceSince = local - landLocal;
  if (landBounce > 0 && bounceSince >= 0) {
    numberScale *= 1 + landBounce * (1 - EASING.springOut(clamp01(bounceSince / 14)));
  }

  // 색: 도달 전 base, 도달 시 land, 이후 base 로 drain
  const drainDur = clamp(p.colorDrainDur ?? 30, 1, 240);
  const sinceLand = local - landLocal;
  const numberColor =
    sinceLand < 0
      ? baseColor
      : mixHex(landColor, baseColor, EASING.easeInOut(clamp01(sinceLand / drainDur)));

  // suffix 리빌
  const suffixChars = Array.from(p.suffix ?? "");
  const n = suffixChars.length;
  const sfxDelay = p.suffixDelay ?? 4;
  const sfxStagger = clamp(p.suffixStagger ?? 5, 1, 60);
  const sfxSettle = clamp(p.suffixSettleDur ?? 9, 1, 60);
  const sScaleFrom = clamp(p.suffixScaleFrom ?? 0.55, 0.1, 3);
  const sRotFrom = clamp(p.suffixRotateFrom ?? 12, -180, 180);
  const sBlurFrom = clamp(p.suffixBlurFrom ?? 0.12, 0, 2);
  const staticSuffix = p.suffixMode === "static";
  const suffix: StatRevealLetter[] = suffixChars.map((ch, k) => {
    // static: 애니 없이 처음부터 완전히 붙어있는 단위(kW, %).
    if (staticSuffix) return { ch, opacity: 1, scale: 1, rotateDeg: 0, blurEm: 0 };
    const revealT = landLocal + sfxDelay + k * sfxStagger;
    const s = local - revealT;
    if (s < 0) {
      return { ch, opacity: 0, scale: sScaleFrom, rotateDeg: sRotFrom, blurEm: sBlurFrom };
    }
    const st = clamp01(s / sfxSettle);
    return {
      ch,
      opacity: EASING.easeOut(st),
      scale: lerp(sScaleFrom, 1, EASING.easeOut(st)),
      // easeOutBack: 0 을 지나쳐 반대로 살짝 갔다 돌아옴 -> 회전 바운스.
      rotateDeg: lerp(sRotFrom, 0, EASING.easeOutBack(st)),
      blurEm: lerp(sBlurFrom, 0, EASING.easeOut(st)),
    };
  });

  // 그룹 슬라이드(숫자 좌측 이동 + 오버슈트 바운스). 창을 suffix 리빌 전체
  // 구간에 맞춰 suffix 가 다 뜰 즈음 안착하게.
  const slideStart = landLocal + (p.slideDelay ?? 0);
  const slideDur =
    p.slideDuration != null
      ? clamp(p.slideDuration, 1, 240)
      : Math.max(
          1,
          sfxDelay + Math.max(0, n - 1) * sfxStagger + sfxSettle + (p.slideExtra ?? 0),
        );
  // 에디터 커스텀 cubic() 지원 — 기본값(easeOutBack)은 기존과 동일
  const slideFn = resolveEasing(p.slideEasing, "easeOutBack");
  // static suffix 는 슬라이드 없음(처음부터 최종 배치). reveal 만 좌측 슬라이드.
  const slideEased = staticSuffix
    ? 1
    : slideFn(clamp01((local - slideStart) / slideDur));

  return {
    prefix,
    digits,
    reserveText,
    digitsReserve: toText,
    numberScale,
    numberColor,
    slideEased,
    suffix,
  };
}

export function intrinsicDuration(
  rawProps: Record<string, unknown>,
  _ctx: { fps: number; unitCount: number },
): number {
  const p = rawProps as StatRevealProps;
  const countDur = clamp(p.countDuration ?? 40, 1, 240);
  const n = Array.from(p.suffix ?? "").length;
  const sfx =
    (p.suffixDelay ?? 4) +
    Math.max(0, n - 1) * clamp(p.suffixStagger ?? 5, 1, 60) +
    clamp(p.suffixSettleDur ?? 9, 1, 60);
  const drain = clamp(p.colorDrainDur ?? 30, 1, 240);
  return Math.max(1, countDur + Math.max(sfx, drain) + 6);
}

export const name = "stat_reveal";
export const labPreset = {
  role: "in" as const,
  props: {
    prefix: "+",
    from: 0,
    to: 55,
    digitsAlign: "left",
    suffix: "ATMs",
    countDuration: 55,
    countEasing: "linear",
    baseColor: "#111111",
    landColor: "#E23B3B",
    colorDrainDur: 14,
    scaleFrom: 1.06,
    settleFrac: 0.7,
    landBounce: 0.12,
    suffixScale: 0.5,
    suffixGap: 0.06,
    suffixDelay: 0,
    suffixStagger: 1,
    suffixSettleDur: 5,
    suffixScaleFrom: 0.55,
    suffixRotateFrom: 12,
    suffixBlurFrom: 0.12,
    slideDelay: 0,
    slideDuration: 10,
    slideEasing: "easeOutBack",
  } as Record<string, unknown>,
};
