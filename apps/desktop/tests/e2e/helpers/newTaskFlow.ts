import {
  buildGlobalKeydownScript,
  buildSelectorKeydownScript,
} from "./keyboard";

export interface NewTaskFlowClient {
  executeSync<T = unknown>(script: string, args?: unknown[]): Promise<T>;
  waitForElement(css: string, timeoutMs?: number): Promise<string>;
  waitForNoElement(css: string, timeoutMs?: number): Promise<void>;
  sendKeys(elementId: string, text: string): Promise<void>;
  click(elementId: string): Promise<void>;
}

export interface SubmitTaskFromUiOptions {
  providerSwitchCount?: number;
}

const NEW_TASK_MODAL_SELECTOR = ".modal-overlay";
const NEW_TASK_TEXTAREA_SELECTOR = ".modal-overlay textarea";
const NEW_TASK_MODAL_INNER_SELECTOR = ".modal";
// The Create button renders immediately but stays disabled until the modal has
// loaded its options (base branches, workflows, agent choices) and Vue has seen
// the typed prompt. Clicking it before then is a silent no-op, so wait for the
// enabled button rather than the button.
const NEW_TASK_SUBMIT_BUTTON_SELECTOR = ".modal-overlay .btn-primary:not(:disabled)";
const NEW_TASK_SUBMIT_ENABLED_TIMEOUT_MS = 10_000;
const CYCLE_PROVIDER_SCRIPT = buildSelectorKeydownScript(NEW_TASK_MODAL_INNER_SELECTOR, {
  key: "]",
  meta: true,
  shift: true,
});

export async function submitTaskFromUi(
  client: NewTaskFlowClient,
  prompt: string,
  options: SubmitTaskFromUiOptions = {},
): Promise<void> {
  await client.executeSync(buildGlobalKeydownScript({
    key: "N",
    meta: true,
    shift: true,
  }));

  await client.waitForElement(NEW_TASK_MODAL_SELECTOR, 2000);
  for (let index = 0; index < (options.providerSwitchCount ?? 0); index += 1) {
    await client.executeSync(CYCLE_PROVIDER_SCRIPT);
  }
  const textarea = await client.waitForElement(NEW_TASK_TEXTAREA_SELECTOR, 2000);
  await client.sendKeys(textarea, prompt);
  const submitButton = await client.waitForElement(
    NEW_TASK_SUBMIT_BUTTON_SELECTOR,
    NEW_TASK_SUBMIT_ENABLED_TIMEOUT_MS,
  );
  await client.click(submitButton);

  try {
    await client.waitForNoElement(NEW_TASK_MODAL_SELECTOR, 5000);
  } catch (error) {
    // ".modal-overlay" is every modal's root, so a bare timeout cannot say
    // whether the New Task modal is stuck or another modal opened over it.
    const overlays = await client.executeSync<string>(
      `return Array.from(document.querySelectorAll(${JSON.stringify(NEW_TASK_MODAL_SELECTOR)}))
         .map((node) => (node.querySelector("h2, h3")?.textContent || node.className).trim()
           + " :: " + (node.textContent || "").trim().slice(0, 120))
         .join(" | ");`,
    ).catch(() => "<unavailable>");
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; remaining overlays: ${overlays}`,
    );
  }
}
