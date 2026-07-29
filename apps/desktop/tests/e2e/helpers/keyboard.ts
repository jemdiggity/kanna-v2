interface KeydownScriptOptions {
  key: string;
  code?: string;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
}

function buildKeyboardEventInit(options: KeydownScriptOptions): string {
  return [
    `key: ${JSON.stringify(options.key)}`,
    `code: ${JSON.stringify(options.code ?? "")}`,
    `metaKey: ${options.meta ?? false}`,
    `shiftKey: ${options.shift ?? false}`,
    `altKey: ${options.alt ?? false}`,
    `ctrlKey: ${options.ctrl ?? false}`,
    "bubbles: true",
    "cancelable: true",
  ].join(",\n  ");
}

export function buildGlobalKeydownScript(options: KeydownScriptOptions): string {
  return `window.dispatchEvent(new KeyboardEvent("keydown", {
  ${buildKeyboardEventInit(options)}
}));`;
}

export function buildHandledGlobalKeydownScript(options: KeydownScriptOptions): string {
  return `const event = new KeyboardEvent("keydown", {
  ${buildKeyboardEventInit(options)}
});
window.dispatchEvent(event);
return event.defaultPrevented;`;
}

export function buildSelectorKeydownScript(
  selector: string,
  options: KeydownScriptOptions,
): string {
  return `const target = document.querySelector(${JSON.stringify(selector)});
target?.dispatchEvent(new KeyboardEvent("keydown", {
  ${buildKeyboardEventInit(options)}
}));`;
}
