# Mobile Server-Owned Task Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route mobile PTY composer submissions through `kanna-server` as plain text so Claude model-picker digits retain their accelerator behavior.

**Architecture:** The React Native composer sends logical text only. LAN and cloud transports both invoke `POST /v1/tasks/{id}/input`, and the existing server handler owns the delayed discrete Enter. The relay's mobile-specific raw `term_input` submission shortcut is removed, while the KSP raw-terminal protocol remains available for true terminal keyboard clients.

**Tech Stack:** React Native, TypeScript, Vitest, Kanna Stream Protocol, Rust `kanna-server`

---

This Kanna stage advances manually and later pipeline stages own commits, so the
steps below intentionally leave the verified changes uncommitted.

### Task 1: Stop Encoding PTY Composer Text as Terminal Controls

**Files:**
- Modify: `apps/mobile/src/state/mobileController.test.ts:1413-1425`
- Modify: `apps/mobile/src/state/mobileController.ts:697-708,756-759`

- [ ] **Step 1: Replace the existing encoding assertion with a failing model-digit regression test**

```ts
it("passes PTY task input to the server without terminal control sequences", async () => {
  const store = createSessionStore();
  const client = createClientMock();
  const controller = createMobileController(client, store);

  await controller.bootstrap();
  await controller.sendTaskInput("task-1", "1");

  expect(client.sendTaskInput).toHaveBeenCalledWith("task-1", "1");
});
```

- [ ] **Step 2: Run the focused test and confirm the regression test fails for the expected wire value**

Run:

```bash
pnpm --dir apps/mobile test -- src/state/mobileController.test.ts
```

Expected: FAIL because the current call contains
`\x1b[200~1\x1b[201~\x1b[13u` instead of plain `1`.

- [ ] **Step 3: Pass one normalized logical value to either the themed-agent stream or PTY server client**

Replace `sendTaskInput` with:

```ts
async sendTaskInput(taskId, input) {
  const submittedInput = input.trim();
  if (!submittedInput) {
    return;
  }

  try {
    const task = findTask(taskId);
    if (task?.agentType === "agent" && activeTaskAgent?.taskId === taskId) {
      activeTaskAgent.subscription.sendInput(submittedInput);
    } else {
      await client.sendTaskInput(taskId, submittedInput);
    }
    store.setErrorMessage(null);
  } catch (error) {
    fail(error);
  }
},
```

Delete `encodeSubmittedTaskInput`; no provider-specific terminal sequences
remain in `mobileController.ts`.

- [ ] **Step 4: Re-run the focused test and confirm it passes**

Run:

```bash
pnpm --dir apps/mobile test -- src/state/mobileController.test.ts
```

Expected: PASS with all tests in the file green.

### Task 2: Route Cloud Task Input Through the Owner Server API

**Files:**
- Modify: `apps/mobile/src/lib/transports/remoteTransport.test.ts:1-10,519-557`
- Modify: `apps/mobile/src/lib/transports/remoteTransport.ts:49-51,73-100,320-337`

- [ ] **Step 1: Replace the raw-terminal-channel test with a failing owner-route assertion**

Keep the existing `RemoteTaskInputSender` available for this red test so the
test proves the transport stops choosing it:

```ts
it("routes cloud task input through the owner server submission endpoint", async () => {
  const invokeDesktop = vi.fn<RemoteDesktopInvoker>().mockResolvedValue(null);
  const rawTerminalSender = vi
    .fn<RemoteTaskInputSender>()
    .mockResolvedValue(undefined);
  const transport = createRemoteTransport({
    listDesktopRecords: async () => [],
    getSelectedDesktopId: () => null,
    invokeDesktop,
    sendTaskInput: rawTerminalSender,
    listCloudTasks: async () => [
      {
        id: "cloud-task-1",
        repoId: "repo-1",
        title: "Cloud task",
        stage: "in progress",
        ownerDesktopId: "desktop-owner",
        ownerLocalTaskId: "local-task-1",
        ownerOnline: true
      }
    ]
  });

  await transport.listRecentTasks();
  invokeDesktop.mockClear();
  await expect(transport.sendTaskInput("cloud-task-1", "1")).resolves.toBeUndefined();

  expect(invokeDesktop).toHaveBeenCalledWith({
    desktopId: "desktop-owner",
    method: "POST",
    path: "/v1/tasks/local-task-1/input",
    body: { input: "1" }
  });
  expect(rawTerminalSender).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the focused transport test and verify the old raw path causes the expected failure**

Run:

```bash
pnpm --dir apps/mobile test -- src/lib/transports/remoteTransport.test.ts
```

Expected: FAIL because `rawTerminalSender` is called and `invokeDesktop` does
not receive the `/input` request.

- [ ] **Step 3: Remove the raw-input branch from the transport implementation**

Replace the task-input method with:

```ts
sendTaskInput: async (taskId: string, input: string) => {
  await requestTask<void>(
    taskId,
    "POST",
    (localTaskId) => `/v1/tasks/${encodeURIComponent(localTaskId)}/input`,
    { input }
  );
},
```

At this point, leave the unused dependency type in place until the test is green
so the behavior change remains isolated.

- [ ] **Step 4: Re-run the focused transport test and confirm it passes**

Run:

```bash
pnpm --dir apps/mobile test -- src/lib/transports/remoteTransport.test.ts
```

Expected: PASS, including the cloud owner/local task-id mapping assertion.

### Task 3: Remove the Obsolete Relay Raw-Submission Surface

**Files:**
- Modify: `apps/mobile/src/lib/transports/remoteTransport.ts:49-51,73-100`
- Modify: `apps/mobile/src/lib/transports/remoteTransport.test.ts:1-10,519-557`
- Modify: `apps/mobile/src/lib/transports/relayClient.ts:20-29,425-428`
- Modify: `apps/mobile/src/lib/transports/relayClient.test.ts:363-393`
- Modify: `apps/mobile/src/appModel.ts:286-299`
- Modify: `apps/mobile/src/appModel.cloudFallback.test.ts:196-204,287-295,385-401`

- [ ] **Step 1: Narrow `RemoteTransportDependencies` to product-facing server operations**

Delete `RemoteTaskInputSender`, remove `sendTaskInput` from
`RemoteTransportDependencies`, and remove it from the
`createRemoteTransport` destructuring. Update the new regression test by
removing `rawTerminalSender`, its dependency property, and its final
`not.toHaveBeenCalled()` assertion; retain the `/input` invocation assertion.

- [ ] **Step 2: Remove the unused raw composer method from `RelayDesktopClient`**

Delete this interface member:

```ts
sendTaskInput(options: { desktopId: string; taskId: string; data: string }): Promise<void>;
```

Delete this implementation member:

```ts
async sendTaskInput({ desktopId, taskId, data }) {
  streamClientForDesktop(desktopId).sendTermInput(taskId, encodeBase64(data));
}
```

Delete the relay-client test named
`"sends terminal input through relay command invokes"`. Raw KSP terminal input
remains covered by `packages/stream-client/src/stream-client.test.ts` and the
server protocol tests.

- [ ] **Step 3: Remove app-model wiring and update typed relay mocks**

Delete this `createRemoteTransport` property from `appModel.ts`:

```ts
sendTaskInput: relayClient.sendTaskInput,
```

Delete `sendTaskInput: vi.fn().mockResolvedValue(undefined)` from each of the
three `RelayDesktopClient` literals in `appModel.cloudFallback.test.ts`.

- [ ] **Step 4: Prove the obsolete surface has no remaining mobile references**

Run:

```bash
rg -n 'RemoteTaskInputSender|relayClient\.sendTaskInput|sendTaskInput\(options' apps/mobile/src
```

Expected: no matches and exit status 1.

- [ ] **Step 5: Run the focused mobile regression set**

Run:

```bash
pnpm --dir apps/mobile test -- \
  src/state/mobileController.test.ts \
  src/lib/transports/remoteTransport.test.ts \
  src/lib/transports/relayClient.test.ts \
  src/lib/transports/lanTransport.test.ts \
  src/appModel.cloudFallback.test.ts
```

Expected: PASS with zero failures.

### Task 4: Verify the Server Boundary and Mobile Package

**Files:**
- Verify: `crates/kanna-server/src/http_api/task_input.rs`
- Verify: `crates/kanna-server/src/http_api/tests/input.rs`
- Verify: all modified files

- [ ] **Step 1: Run the existing server discrete-input regression**

Run:

```bash
cargo test -p kanna-server submit_task_input_sends_text_then_enter_as_discrete_inputs
```

Expected: PASS, proving the server writes text and Enter as distinct daemon
inputs.

- [ ] **Step 2: Run the full mobile unit suite**

Run:

```bash
pnpm --dir apps/mobile test
```

Expected: all mobile test files and tests pass with zero failures.

- [ ] **Step 3: Run the mobile TypeScript compiler**

Run:

```bash
pnpm --dir apps/mobile run typecheck
```

Expected: exit status 0 with no TypeScript diagnostics.

- [ ] **Step 4: Check formatting and inspect the final diff**

Run:

```bash
git diff --check
git status --short
git diff -- \
  apps/mobile/src/state/mobileController.ts \
  apps/mobile/src/state/mobileController.test.ts \
  apps/mobile/src/lib/transports/remoteTransport.ts \
  apps/mobile/src/lib/transports/remoteTransport.test.ts \
  apps/mobile/src/lib/transports/relayClient.ts \
  apps/mobile/src/lib/transports/relayClient.test.ts \
  apps/mobile/src/appModel.ts \
  apps/mobile/src/appModel.cloudFallback.test.ts
```

Expected: no whitespace errors; only the approved input-boundary changes and
their tests are present. The design and plan documents remain uncommitted for
the later Kanna pipeline stage.

- [ ] **Step 5: Assess the existing relay Appium lane without running physical-device automation**

If a kd-managed iOS simulator/Appium stack is already available, run:

```bash
./kd test remote-e2e --mobile-relay
```

Otherwise, report the lane as not run locally. Do not install, launch, or drive
an attached physical iPhone; the existing Layer C relay flow remains the E2E
coverage for UI -> relay -> server -> daemon input.
