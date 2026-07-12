import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * cn — clsx + tailwind-merge 결합 헬퍼.
 *
 * 사용 패턴:
 *   cn("base-class", condition && "conditional", props.className)
 *
 * 주의: CSS Modules 클래스명 (해시 붙은 것) 에는 tailwind-merge 가 작동 안 함.
 * Modules 는 직접 조합하고, 유틸리티 클래스만 이 헬퍼로 병합.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
