# Mobile Search Input Focus

**Date:** 2026-07-17
**Status:** Approved design

## Goal

When a user taps the mobile toolbar's magnifying-glass action, open the Search view and place the cursor in the **Search tasks** input so the keyboard is ready immediately. Every magnifier tap is a new focus request, including taps made while Search is already open after the keyboard has been dismissed.

## Design

`App` owns a transient integer focus-request key. Selecting the search utility action increments the key and calls the existing `controller.showView("search")` navigation path. `SearchScreen` receives the key, keeps a ref to its `TextInput`, and calls `focus()` in an effect whenever the key changes.

The first tap both mounts `SearchScreen` and supplies the latest request key. Later taps change the key without remounting the screen, so they restore focus while preserving the current query and results. Navigation from any non-magnifier path does not create a focus request.

This is preferable to `autoFocus`, which cannot refocus an already-mounted input, and to keying the entire screen, which would remount more UI than necessary.

## Scope and Compatibility

The change is confined to the React Native app shell and search screen. It does not change query state, search requests, result rendering, navigation models, native configuration, dependencies, or the mobile OTA runtime version.

If a focus request arrives before the screen is mounted, React commits the screen with the new key and its effect focuses the mounted input. React Native handles keyboard presentation through the normal `TextInput.focus()` behavior; no timer or platform-specific keyboard API is needed.

## Testing

Component coverage will verify that `SearchScreen` does not focus without a request, focuses its input on the initial positive request, and focuses it again when the request key changes while preserving its query value. App wiring coverage will verify that each magnifier action advances the request key and continues to select the Search view.

Focused verification uses:

```bash
pnpm --dir apps/mobile test -- SearchScreen.test.tsx App.component.test.tsx
pnpm --dir apps/mobile run typecheck
```

## Out of Scope

- Clearing or selecting the existing query text.
- Automatically focusing Search when reached through any path other than the magnifier action.
- Changing search debounce, transport, or result behavior.
- Adding platform-specific keyboard timing workarounds without evidence they are necessary.
