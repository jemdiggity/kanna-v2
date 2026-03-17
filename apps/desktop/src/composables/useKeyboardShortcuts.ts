import { onMounted, onUnmounted } from "vue";

export interface KeyboardActions {
  newTask: () => void;
  merge: () => void;
  closeTask: () => void;
  toggleZen: () => void;
  navigateUp: () => void;
  navigateDown: () => void;
  exitZen: () => void;
}

export function useKeyboardShortcuts(actions: KeyboardActions) {
  function handler(e: KeyboardEvent) {
    const meta = e.metaKey || e.ctrlKey;

    // Cmd+N -> new task
    if (meta && e.key === "n") {
      e.preventDefault();
      actions.newTask();
      return;
    }

    // Cmd+M -> merge
    if (meta && e.key === "m") {
      e.preventDefault();
      actions.merge();
      return;
    }

    // Cmd+Delete -> close task
    if (meta && (e.key === "Backspace" || e.key === "Delete")) {
      e.preventDefault();
      actions.closeTask();
      return;
    }

    // Cmd+Z -> toggle zen (only without shift to avoid conflict with undo)
    if (meta && e.key === "z" && !e.shiftKey) {
      // Let Cmd+Z through for undo in textareas
      const target = e.target as HTMLElement;
      if (target.tagName === "TEXTAREA" || target.tagName === "INPUT") return;
      e.preventDefault();
      actions.toggleZen();
      return;
    }

    // Cmd+Up -> navigate up
    if (meta && e.key === "ArrowUp") {
      e.preventDefault();
      actions.navigateUp();
      return;
    }

    // Cmd+Down -> navigate down
    if (meta && e.key === "ArrowDown") {
      e.preventDefault();
      actions.navigateDown();
      return;
    }

    // Escape -> exit zen
    if (e.key === "Escape") {
      actions.exitZen();
      return;
    }
  }

  onMounted(() => {
    window.addEventListener("keydown", handler);
  });

  onUnmounted(() => {
    window.removeEventListener("keydown", handler);
  });
}
