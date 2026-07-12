// 커스텀 confirm/prompt — 브라우저 기본 alert 류 대체 (에디터 톤 유지).
// promise 기반이라 기존 window.confirm/prompt 자리에 await 로 끼운다.

"use client";

import React from "react";
import { create } from "zustand";

type DialogReq =
  | { kind: "confirm"; title: string; message?: string; danger?: boolean; okLabel?: string; resolve: (ok: boolean) => void }
  | { kind: "prompt"; title: string; message?: string; defaultValue?: string; placeholder?: string; okLabel?: string; resolve: (v: string | null) => void };

const useDialogs = create<{ req: DialogReq | null; set: (r: DialogReq | null) => void }>((set) => ({
  req: null,
  set: (req) => set({ req }),
}));

export function uiConfirm(title: string, opts?: { message?: string; danger?: boolean; okLabel?: string }): Promise<boolean> {
  return new Promise((resolve) => {
    useDialogs.getState().set({ kind: "confirm", title, ...opts, resolve });
  });
}

export function uiPrompt(title: string, defaultValue?: string, opts?: { message?: string; placeholder?: string; okLabel?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    useDialogs.getState().set({ kind: "prompt", title, defaultValue, ...opts, resolve });
  });
}

export function DialogHost() {
  const req = useDialogs((s) => s.req);
  const [value, setValue] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (req?.kind === "prompt") {
      setValue(req.defaultValue ?? "");
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 30);
    }
  }, [req]);

  if (!req) return null;

  const done = (ok: boolean) => {
    if (req.kind === "confirm") req.resolve(ok);
    else req.resolve(ok ? value : null);
    useDialogs.getState().set(null);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") done(true);
    if (e.key === "Escape") done(false);
  };

  const btn = (primary: boolean, danger?: boolean): React.CSSProperties => ({
    padding: "8px 14px",
    borderRadius: 8,
    border: primary ? "none" : "1px solid #2A3245",
    background: primary ? (danger ? "#DC2626" : "#4A5AE8") : "transparent",
    color: primary ? "#FFFFFF" : "#C6CEDD",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  });

  return (
    <>
      <style>{`
        @keyframes dlgFade { from { opacity: 0; } to { opacity: 1; } }
        @keyframes dlgPop { from { opacity: 0; transform: translate(-50%, -47%) scale(0.97); } to { opacity: 1; transform: translate(-50%, -50%) scale(1); } }
      `}</style>
      <div
        style={{ position: "fixed", inset: 0, zIndex: 500, background: "rgba(5,7,12,0.55)", animation: "dlgFade 140ms ease-out" }}
        onPointerDown={() => done(false)}
      />
      <div
        role="dialog"
        onKeyDown={onKey}
        style={{
          position: "fixed",
          left: "50%",
          top: "50%",
          transform: "translate(-50%, -50%)",
          zIndex: 501,
          animation: "dlgPop 170ms cubic-bezier(0.2, 0.9, 0.3, 1)",
          background: "#0F131C",
          border: "1px solid #232B3B",
          borderRadius: 14,
          boxShadow: "0 20px 70px rgba(0,0,0,0.5)",
          width: 400,
          maxWidth: "92vw",
          padding: "18px 18px 16px",
        }}
      >
        <div style={{ color: "#F4F6FB", fontSize: 13, fontWeight: 600, marginBottom: req.message || req.kind === "prompt" ? 8 : 16 }}>{req.title}</div>
        {req.message && <div style={{ color: "#8B95A5", fontSize: 12, lineHeight: 1.5, marginBottom: 12 }}>{req.message}</div>}
        {req.kind === "prompt" && (
          <input
            ref={inputRef}
            value={value}
            placeholder={req.placeholder}
            onChange={(e) => setValue(e.target.value)}
            style={{
              width: "100%",
              boxSizing: "border-box",
              background: "#141926",
              border: "1px solid #2A3245",
              borderRadius: 8,
              padding: "8px 10px",
              color: "#F4F6FB",
              fontSize: 13,
              outline: "none",
              marginBottom: 14,
            }}
          />
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button style={btn(false)} onClick={() => done(false)}>
            Cancel
          </button>
          <button style={btn(true, (req as { danger?: boolean }).danger)} onClick={() => done(true)} autoFocus={req.kind === "confirm"}>
            {req.okLabel ?? "OK"}
          </button>
        </div>
      </div>
    </>
  );
}
