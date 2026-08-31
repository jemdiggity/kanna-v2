/**
 * W3C WebDriver HTTP client for tauri-plugin-webdriver.
 */
import { writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import { APP_READY_SCRIPT } from "./appReady";
import { pauseForSlowMode } from "./slowMode";
import { dismissStartupShortcutsModal } from "./startupOverlays";
import { getWebDriverPort } from "./webdriverPort";

const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

interface CreateSessionOptions {
  dismissStartupShortcuts?: boolean;
}

interface ElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowRectInput {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

export class WebDriverClient {
  private baseUrl: string;
  private sessionId: string | null = null;

  constructor(port = getWebDriverPort()) {
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  // ── Session lifecycle ─────────────────────────────────────────────

  async createSession(options: CreateSessionOptions = {}): Promise<string> {
    const res = await this.post("/session", { capabilities: {} });
    this.sessionId = res.value.sessionId;
    await this.waitForAppReady();
    if (options.dismissStartupShortcuts ?? true) {
      await dismissStartupShortcutsModal(this);
    }
    return this.sessionId;
  }

  /**
   * Reload the webview and wait for the fresh page to finish starting up.
   *
   * Clearing the readiness flags first is the whole point: `location.reload()`
   * returns before the navigation happens, so a bare `waitForAppReady()` can
   * observe the *outgoing* page's flags and return while the old DOM is still
   * up. Startup work of the new page then lands mid-test — which is how the
   * startup shortcuts modal reappeared after it had "already been dismissed".
   */
  async reload(options: CreateSessionOptions = {}): Promise<void> {
    await this.executeSync(
      `if (window.__KANNA_E2E__) {
         window.__KANNA_E2E__.ready = false;
         window.__KANNA_E2E__.startupOverlaysSettled = false;
       }
       location.reload();`,
    );
    await this.waitForAppReady();
    if (options.dismissStartupShortcuts ?? true) {
      await dismissStartupShortcutsModal(this);
    }
  }

  async deleteSession(): Promise<void> {
    if (!this.sessionId) return;
    await this.delete(`/session/${this.sessionId}`);
    this.sessionId = null;
  }

  // ── Element interaction ───────────────────────────────────────────

  async findElement(css: string): Promise<string> {
    const res = await this.post(`/session/${this.sid}/element`, {
      using: "css selector",
      value: css,
    });
    return res.value[ELEMENT_KEY];
  }

  async findElements(css: string): Promise<string[]> {
    const res = await this.post(`/session/${this.sid}/elements`, {
      using: "css selector",
      value: css,
    });
    return res.value.map((el: Record<string, string>) => el[ELEMENT_KEY]);
  }

  async click(elementId: string): Promise<void> {
    await this.post(`/session/${this.sid}/element/${elementId}/click`, {});
    await pauseForSlowMode("webdriver click");
  }

  async pointerDoublePress(elementId: string): Promise<void> {
    const rect = await this.getElementRect(elementId);
    const point = {
      x: Math.round(rect.x + rect.width / 2),
      y: Math.round(rect.y + rect.height / 2),
    };

    await this.post(`/session/${this.sid}/actions`, {
      actions: [
        {
          type: "pointer",
          id: "mouse",
          parameters: { pointerType: "mouse" },
          actions: [
            { type: "pointerMove", duration: 0, origin: "viewport", x: point.x, y: point.y },
            { type: "pointerDown", button: 0 },
            { type: "pointerUp", button: 0 },
            { type: "pause", duration: 40 },
            { type: "pointerDown", button: 0 },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
    await pauseForSlowMode("webdriver pointer double press");
  }

  async pointerPressAt(x: number, y: number): Promise<void> {
    await this.post(`/session/${this.sid}/actions`, {
      actions: [
        {
          type: "pointer",
          id: "mouse",
          parameters: { pointerType: "mouse" },
          actions: [
            {
              type: "pointerMove",
              duration: 0,
              origin: "viewport",
              x: Math.round(x),
              y: Math.round(y),
            },
            { type: "pointerDown", button: 0 },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
    await pauseForSlowMode("webdriver pointer press");
  }

  async getText(elementId: string): Promise<string> {
    const res = await this.get(`/session/${this.sid}/element/${elementId}/text`);
    return res.value;
  }

  async sendKeys(elementId: string, text: string): Promise<void> {
    await this.post(`/session/${this.sid}/element/${elementId}/value`, {
      text,
    });
    await pauseForSlowMode("webdriver send keys");
  }

  async clear(elementId: string): Promise<void> {
    await this.post(`/session/${this.sid}/element/${elementId}/clear`, {});
    await pauseForSlowMode("webdriver clear");
  }

  async pressKey(value: string): Promise<void> {
    await this.post(`/session/${this.sid}/actions`, {
      actions: [
        {
          type: "key",
          id: "keyboard",
          actions: [
            { type: "keyDown", value },
            { type: "keyUp", value },
          ],
        },
      ],
    });
    await pauseForSlowMode(`webdriver press ${value}`);
  }

  async pressShortcut(keys: string[]): Promise<void> {
    const webdriverKeys: Record<string, string> = {
      Meta: "\uE03D",
      Control: "\uE009",
      Alt: "\uE00A",
      Shift: "\uE008",
    };
    const values = keys.map((key) => webdriverKeys[key] ?? key);
    const releasedValues = [...values].reverse();
    await this.post(`/session/${this.sid}/actions`, {
      actions: [
        {
          type: "key",
          id: "keyboard",
          actions: [
            ...values.map((value) => ({ type: "keyDown", value })),
            ...releasedValues.map((value) => ({ type: "keyUp", value })),
          ],
        },
      ],
    });
    await pauseForSlowMode(`webdriver shortcut ${keys.join("+")}`);
  }

  async emitToWebviewWindow(event: string, payload: unknown = null, label = "main"): Promise<void> {
    const result = await this.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       window.__TAURI_INTERNALS__.invoke("plugin:event|emit_to", {
         target: { kind: "WebviewWindow", label: ${JSON.stringify(label)} },
         event: ${JSON.stringify(event)},
         payload: ${JSON.stringify(payload)},
       }).then(function() { cb("ok"); }).catch(function(e) { cb("err:" + e); });`,
    );
    if (result !== "ok") {
      throw new Error(`emitToWebviewWindow(${event}) failed: ${result}`);
    }
  }

  async getElementRect(elementId: string): Promise<ElementRect> {
    const res = await this.get(`/session/${this.sid}/element/${elementId}/rect`);
    return res.value as ElementRect;
  }

  async getWindowRect(): Promise<WindowRect> {
    const res = await this.get(`/session/${this.sid}/window/rect`);
    return res.value as WindowRect;
  }

  async setWindowRect(rect: WindowRectInput): Promise<void> {
    await this.post(`/session/${this.sid}/window/rect`, rect);
  }

  async getWindowHandles(): Promise<string[]> {
    const res = await this.get(`/session/${this.sid}/window/handles`);
    return res.value as string[];
  }

  async switchToWindow(handle: string): Promise<void> {
    await this.post(`/session/${this.sid}/window`, { handle });
  }

  async pointerDragBy(
    elementId: string,
    delta: { x: number; y: number },
    startRatio: { x: number; y: number } = { x: 0.8, y: 0.5 },
  ): Promise<void> {
    const rect = await this.getElementRect(elementId);
    const start = {
      x: Math.round(rect.x + rect.width * startRatio.x),
      y: Math.round(rect.y + rect.height * startRatio.y),
    };
    const dragged = await this.executeAsync<boolean>(
      `const cb = arguments[arguments.length - 1];
       const source = document.elementFromPoint(${start.x}, ${start.y});
       const modal = source?.closest(".tree-modal, .diff-modal");
       if (!(source instanceof Element) || !(modal instanceof HTMLElement)) {
         cb(false);
         return;
       }
       const pointerId = 41;
       const fire = (target, type, x, y, buttons) => target.dispatchEvent(new PointerEvent(type, {
         pointerId,
         pointerType: "mouse",
         bubbles: true,
         cancelable: true,
         button: 0,
         buttons,
         clientX: x,
         clientY: y,
         screenX: window.screenX + x,
         screenY: window.screenY + y,
       }));
       fire(source, "pointerdown", ${start.x}, ${start.y}, 1);
       setTimeout(() => {
         fire(modal, "pointermove", ${start.x + delta.x}, ${start.y + delta.y}, 1);
         setTimeout(() => {
           fire(modal, "pointerup", ${start.x + delta.x}, ${start.y + delta.y}, 0);
           cb(true);
         }, 80);
       }, 80);`,
    );
    if (!dragged) throw new Error("pointer drag source is not inside a supported modal");
    await pauseForSlowMode("webdriver pointer drag");
  }

  async dragElementToElement(sourceElementId: string, targetElementId: string): Promise<void> {
    const source = await this.getElementRect(sourceElementId);
    const target = await this.getElementRect(targetElementId);
    const start = {
      x: Math.round(source.x + source.width / 2),
      y: Math.round(source.y + source.height / 2),
    };
    const end = {
      x: Math.round(target.x + target.width / 2),
      y: Math.round(target.y + 4),
    };
    const middle = {
      x: end.x,
      y: Math.round((start.y + end.y) / 2),
    };
    const points = JSON.stringify({ start, middle, end });

    await this.executeAsync<boolean>(
      `const cb = arguments[arguments.length - 1];
       const points = ${points};
       function fire(type, point, buttons) {
         const element = document.elementFromPoint(point.x, point.y) || document.body;
         const event = new MouseEvent(type, {
           view: window,
           bubbles: true,
           cancelable: true,
           clientX: point.x,
           clientY: point.y,
           screenX: point.x,
           screenY: point.y,
           button: 0,
           buttons,
         });
         element.dispatchEvent(event);
         if (type !== "mousedown") {
           document.dispatchEvent(new MouseEvent(type, {
             view: window,
             bubbles: true,
             cancelable: true,
             clientX: point.x,
             clientY: point.y,
             screenX: point.x,
             screenY: point.y,
             button: 0,
             buttons,
           }));
         }
       }
       fire("mousemove", points.start, 0);
       fire("mousedown", points.start, 1);
       setTimeout(() => {
         fire("mousemove", { x: points.start.x, y: points.start.y - 8 }, 1);
         setTimeout(() => {
           fire("mousemove", points.middle, 1);
           setTimeout(() => {
             fire("mousemove", points.end, 1);
             setTimeout(() => {
               fire("mouseup", points.end, 0);
               cb(true);
             }, 100);
           }, 100);
         }, 100);
       }, 100);`,
    );
  }

  // ── JavaScript execution ──────────────────────────────────────────

  async executeSync<T = unknown>(
    script: string,
    args: unknown[] = []
  ): Promise<T> {
    const res = await this.post(`/session/${this.sid}/execute/sync`, {
      script,
      args,
    });
    if (isKeyboardScript(script)) {
      await pauseForSlowMode("webdriver keyboard shortcut");
    }
    return res.value as T;
  }

  async executeAsync<T = unknown>(
    script: string,
    args: unknown[] = []
  ): Promise<T> {
    const res = await this.post(`/session/${this.sid}/execute/async`, {
      script,
      args,
    });
    if (isKeyboardScript(script)) {
      await pauseForSlowMode("webdriver keyboard shortcut");
    }
    return res.value as T;
  }

  // ── Utilities ─────────────────────────────────────────────────────

  async getTitle(): Promise<string> {
    const res = await this.get(`/session/${this.sid}/title`);
    return res.value;
  }

  async screenshot(path?: string): Promise<string> {
    const res = await this.get(`/session/${this.sid}/screenshot`);
    const b64: string = res.value;
    if (path) {
      const buf = Buffer.from(b64, "base64");
      await writeFile(path, buf);
    }
    return b64;
  }

  async waitForElement(
    css: string,
    timeoutMs = 10000
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        return await this.findElement(css);
      } catch {
        await sleep(200);
      }
    }
    throw new Error(`waitForElement("${css}") timed out after ${timeoutMs}ms`);
  }

  async waitForText(
    css: string,
    text: string,
    timeoutMs = 10000
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const elements = await this.findElements(css);
        for (const elementId of elements) {
          const content = await this.getText(elementId);
          if (content.includes(text)) return elementId;
        }
      } catch {
        // Element might not exist yet
      }
      await sleep(200);
    }
    throw new Error(
      `waitForText("${css}", "${text}") timed out after ${timeoutMs}ms`
    );
  }

  async waitForNoElement(
    css: string,
    timeoutMs = 5000
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await this.findElement(css);
        await sleep(200);
      } catch {
        return; // Element not found — success
      }
    }
    throw new Error(
      `waitForNoElement("${css}") — element still exists after ${timeoutMs}ms`
    );
  }

  async waitForAppReady(timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const ready = await this.executeSync<boolean>(`return ${APP_READY_SCRIPT};`);
        if (ready) return;
      } catch {
        // The window may still be booting.
      }
      await sleep(200);
    }
    throw new Error(`waitForAppReady timed out after ${timeoutMs}ms`);
  }

  // ── Internal HTTP helpers ─────────────────────────────────────────

  private get sid(): string {
    if (!this.sessionId) throw new Error("No WebDriver session. Call createSession() first.");
    return this.sessionId;
  }

  private async get(path: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`);
    const body = await res.json();
    if (body.value?.error) throw new Error(`WebDriver error: ${body.value.message}`);
    return body;
  }

  private async post(path: string, data: unknown): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    const body = await res.json();
    if (body.value?.error) throw new Error(`WebDriver error: ${body.value.message}`);
    return body;
  }

  private async delete(path: string): Promise<void> {
    await fetch(`${this.baseUrl}${path}`, { method: "DELETE" });
  }
}

function isKeyboardScript(script: string): boolean {
  return script.includes("KeyboardEvent(\"keydown\"") || script.includes("KeyboardEvent('keydown'");
}
