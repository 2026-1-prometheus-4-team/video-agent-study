import { uiConfirm } from "@/editor/ui/dialogs";
"use client";

import { useEditor } from "@/editor/store";

// 새 문서 (더티면 확인)
export async function newDocGuarded(dirty: boolean) {
  if (dirty && !(await uiConfirm("Discard unsaved changes?", { message: "You have unsaved changes. Start a new blank document?", danger: true, okLabel: "Discard" }))) return;
  useEditor.getState().newDoc();
}
