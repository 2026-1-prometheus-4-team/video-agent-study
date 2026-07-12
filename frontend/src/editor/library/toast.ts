"use client";

// 최소 토스트 — 마운트된 컴포넌트 없이 DOM 에 직접 띄운다 (2.4s 자동 소멸).

let container: HTMLDivElement | null = null;

function ensure(): HTMLDivElement {
  if (container) return container;
  const el = document.createElement("div");
  el.style.cssText =
    "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2000;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none";
  document.body.appendChild(el);
  container = el;
  return el;
}

export function showToast(msg: string, kind: "info" | "error" = "info") {
  const root = ensure();
  const chip = document.createElement("div");
  chip.textContent = msg;
  const color = kind === "error" ? "var(--danger)" : "var(--text-1)";
  chip.style.cssText = `padding:8px 14px;border-radius:10px;background:var(--bg-float);box-shadow:var(--shadow-float);color:${color};font-size:12px;opacity:0;transform:translateY(6px);transition:opacity 160ms,transform 160ms`;
  root.appendChild(chip);
  requestAnimationFrame(() => {
    chip.style.opacity = "1";
    chip.style.transform = "translateY(0)";
  });
  setTimeout(() => {
    chip.style.opacity = "0";
    chip.style.transform = "translateY(6px)";
    setTimeout(() => chip.remove(), 200);
  }, 2400);
}
