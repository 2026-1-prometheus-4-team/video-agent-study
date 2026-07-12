"use client";

// customEasings — 사용자 커스텀 이징(이름 붙인 cubic-bezier) 라이브러리.
// /api/easings 로 영구 저장. 갤러리/적용/삭제에 쓴다. spec 에는 cubic() 문자열로
// 적용되므로(엔진 호환) 이 파일은 이름/재사용 메타.

import React from "react";

export type CustomEasing = { name: string; bezier: [number, number, number, number] };

let cache: CustomEasing[] = [];
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

async function fetchList(): Promise<CustomEasing[]> {
  try {
    const res = await fetch("/api/easings");
    const d = await res.json();
    cache = Array.isArray(d.easings) ? d.easings : [];
  } catch {
    cache = [];
  }
  notify();
  return cache;
}

async function save(list: CustomEasing[]): Promise<boolean> {
  cache = list;
  notify();
  try {
    const res = await fetch("/api/easings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ easings: list }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function addCustomEasing(name: string, bezier: [number, number, number, number]): Promise<boolean> {
  const clean = name.trim().replace(/[^a-zA-Z0-9_가-힣 -]/g, "").slice(0, 40) || "custom";
  const next = cache.filter((e) => e.name !== clean);
  next.push({ name: clean, bezier });
  next.sort((a, b) => a.name.localeCompare(b.name));
  return save(next);
}

export async function deleteCustomEasing(name: string): Promise<boolean> {
  return save(cache.filter((e) => e.name !== name));
}

/** cubic() 문자열이 등록된 커스텀과 일치하면 그 이름 반환(표시용). */
export function matchCustomName(bez: [number, number, number, number]): string | null {
  const eq = (a: number, b: number) => Math.abs(a - b) < 0.0005;
  const m = cache.find((e) => e.bezier.every((v, i) => eq(v, bez[i])));
  return m?.name ?? null;
}

/** React 훅: 커스텀 이징 목록 구독(첫 마운트 시 fetch). */
export function useCustomEasings(): CustomEasing[] {
  const [list, setList] = React.useState<CustomEasing[]>(cache);
  React.useEffect(() => {
    const update = () => setList([...cache]);
    listeners.add(update);
    void fetchList();
    return () => {
      listeners.delete(update);
    };
  }, []);
  return list;
}
