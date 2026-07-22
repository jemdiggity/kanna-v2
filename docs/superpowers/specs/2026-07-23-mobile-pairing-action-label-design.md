# Mobile Pairing Action Label Design

## Goal

Make the Preferences → Mobile pairing action describe whether it will begin a pairing session or replace the currently displayed session.

## Behavior

- Show **Start pairing** when no valid pairing code is visible.
- Show **Refresh** while a valid pairing code is visible because clicking the action replaces that session with a newly generated code.
- Return to **Start pairing** when the displayed session expires.
- Keep the existing pairing-session creation behavior and error handling unchanged.

## Implementation

`MobileAccessPanel` will derive the label from the same pairing-code and expiration state that controls whether pairing credentials are rendered. This avoids separate UI state that could drift from the displayed session.

## Testing

The component test will verify the inactive label, the active-session label, and the label after expiration. No backend or end-to-end behavior changes are required.
