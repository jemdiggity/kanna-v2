# Mobile Terminal Edge-Back Gesture Design

## Goal

Allow an iOS user viewing a task's agent terminal to return to the underlying
task list with the standard system back gesture: begin at the left screen edge
and drag right. Preserve the existing visible back button.

## Design

`TaskDetail` is already a screen in the root native stack above `MainTabs`, and
its existing `navigation.goBack()` path returns to the task list or other route
that opened it. Configure that screen explicitly with native-stack horizontal
gesture dismissal enabled and full-screen gesture dismissal disabled.

The native stack remains responsible for recognizing the edge gesture,
rendering the interactive transition, and completing or cancelling the pop.
No gesture recognizer or navigation state is added to `TaskScreen` or
`TerminalWebView`.

## Interaction Boundaries

- The gesture is iOS-only because native-stack gesture dismissal is an iOS
  capability.
- Recognition begins at the system-defined left edge and moves right.
- Swipes elsewhere in the terminal remain available to the terminal WebView for
  scrolling, terminal mouse input, text selection, and other touch behavior.
- The existing back button continues to call the same navigation pop.
- Android behavior is unchanged.

## Alternatives Considered

### Custom edge pan recognizer

A React Native pan responder or transparent edge overlay could invoke
`goBack()`. This would duplicate native navigation behavior, would not naturally
provide the interactive system transition, and could compete with the terminal
WebView for touches.

### Full-screen native back gesture

Native stack can recognize dismissal across the entire screen. This offers a
larger target but conflicts with horizontal terminal interactions and exceeds
the requested standard iOS edge gesture.

## Testing

Add focused component coverage that inspects the `TaskDetail` screen options
and proves that edge dismissal is enabled while full-screen dismissal is not.
Run the focused mobile navigation test, the mobile test suite, and the mobile
TypeScript check if available.

The unit test verifies the configuration boundary. The operating system owns
the physical gesture and animation, so simulator or device smoke testing remains
the end-to-end confirmation of touch recognition.
