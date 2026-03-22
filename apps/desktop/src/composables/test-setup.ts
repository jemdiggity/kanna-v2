// Test preload: set up happy-dom globals for composable tests that need DOM APIs.
import { Window } from "happy-dom";

const win = new Window();
// @ts-ignore
globalThis.document = win.document;
// @ts-ignore
globalThis.window = win;
// @ts-ignore — use happy-dom's Event so dispatchEvent instanceof check passes
globalThis.Event = win.Event;
