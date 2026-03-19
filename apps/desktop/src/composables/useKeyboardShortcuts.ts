import { onMounted, onUnmounted } from "vue";

export interface KeyboardActions {
  // Pipeline
  newTask: () => void;
  openFile: () => void;
  makePR: () => void;
  merge: () => void;
  // Navigation
  navigateUp: () => void;
  navigateDown: () => void;
  toggleZen: () => void;
  dismiss: () => void;
  // Terminal
  openShell: () => void;
  // Window
  newWindow: () => void;
  // Views
  showDiff: () => void;
  // Help
  showShortcuts: () => void;
  openPreferences: () => void;
}

export function useKeyboardShortcuts(actions: KeyboardActions) {
  function handler(e: KeyboardEvent) {
    const meta = e.metaKey || e.ctrlKey;

    // Escape — dismiss whatever's open
    if (e.key === "Escape") {
      actions.dismiss();
      return;
    }

    // Shift+Cmd+N → New Task
    if (meta && e.shiftKey && e.key === "N") {
      e.preventDefault();
      actions.newTask();
      return;
    }

    // Cmd+N → New Window
    if (meta && !e.shiftKey && e.key === "n") {
      e.preventDefault();
      actions.newWindow();
      return;
    }

    // Cmd+P → Open File
    if (meta && e.key === "p") {
      e.preventDefault();
      actions.openFile();
      return;
    }

    // Cmd+S → Make PR
    if (meta && !e.shiftKey && e.key === "s") {
      e.preventDefault();
      actions.makePR();
      return;
    }

    // Cmd+M → Merge PR
    if (meta && e.key === "m") {
      e.preventDefault();
      actions.merge();
      return;
    }

    // Option+Cmd+Down → Next Task
    if (meta && e.altKey && e.key === "ArrowDown") {
      e.preventDefault();
      actions.navigateDown();
      return;
    }

    // Option+Cmd+Up → Previous Task
    if (meta && e.altKey && e.key === "ArrowUp") {
      e.preventDefault();
      actions.navigateUp();
      return;
    }

    // Shift+Cmd+Z → Zen Mode
    if (meta && e.shiftKey && e.key === "Z") {
      e.preventDefault();
      actions.toggleZen();
      return;
    }

    // Cmd+J → Open Shell
    if (meta && e.key === "j") {
      e.preventDefault();
      actions.openShell();
      return;
    }

    // Cmd+D → Show Diff
    if (meta && !e.shiftKey && e.key === "d") {
      e.preventDefault();
      actions.showDiff();
      return;
    }

    // Cmd+/ → Show Shortcuts
    if (meta && e.key === "/") {
      e.preventDefault();
      actions.showShortcuts();
      return;
    }

    // Cmd+, → Preferences
    if (meta && e.key === ",") {
      e.preventDefault();
      actions.openPreferences();
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
