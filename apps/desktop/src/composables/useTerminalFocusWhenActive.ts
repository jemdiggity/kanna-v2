import { nextTick } from "vue";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { isTauri } from "../tauri-mock";
import { nextFrameOrTimeout } from "../utils/animationFrame";

interface FocusableTerminal {
  focus(): void;
}

interface TerminalFocusWhenActiveOptions {
  isActive: () => boolean;
  getTerminal: () => FocusableTerminal | null;
}

function shouldPreserveCurrentFocus(): boolean {
  if (document.querySelector(".modal-overlay")) return true;
  const activeElement = document.activeElement;
  return activeElement instanceof HTMLElement
    && activeElement.matches(".sidebar input, .sidebar textarea");
}

async function restoreNativeWebviewFocus(): Promise<void> {
  if (!isTauri) return;
  try {
    await getCurrentWebview().setFocus();
  } catch (error: unknown) {
    console.warn("[terminal] failed to restore native webview focus:", error);
  }
}

export function useTerminalFocusWhenActive({
  isActive,
  getTerminal,
}: TerminalFocusWhenActiveOptions) {
  let focusGeneration = 0;

  function cancelPendingFocus(): void {
    focusGeneration += 1;
  }

  async function focusWhenActive(): Promise<void> {
    const generation = ++focusGeneration;
    if (!isActive() || !getTerminal() || shouldPreserveCurrentFocus()) return;
    await nextTick();
    if (
      generation !== focusGeneration
      || !isActive()
      || !getTerminal()
      || shouldPreserveCurrentFocus()
    ) return;
    await restoreNativeWebviewFocus();
    await nextFrameOrTimeout();
    const terminal = getTerminal();
    if (
      generation !== focusGeneration
      || !isActive()
      || !terminal
      || shouldPreserveCurrentFocus()
    ) return;
    terminal.focus();
  }

  return {
    cancelPendingFocus,
    focusWhenActive,
  };
}
