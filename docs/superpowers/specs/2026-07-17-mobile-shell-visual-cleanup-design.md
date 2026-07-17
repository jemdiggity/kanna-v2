# Mobile Shell Visual Cleanup Design

## Summary

Simplify the Kanna mobile shell by removing its two abstract blue background
shapes and replacing the layered ambient treatment with a flat, deliberate dark
canvas. The change should make the interface feel quieter and more confident
without expanding into a broad rebrand.

## Problem

The root app shell currently renders two large, low-opacity blue circles behind
every top-level screen. These shapes do not communicate product state or help
navigation. They add a generic dark-SaaS visual treatment that competes with
Kanna's task content and floating toolbar.

The surrounding shell also mixes a flat safe-area color with translucent toolbar
surfaces designed to sit over the ambient shapes. Once the shapes are removed,
the shell chrome should use a small, consistent set of opaque dark surfaces.

## Scope

- Remove the `backgroundGlow` and `backgroundOrb` elements from the root mobile
  app shell.
- Remove their unused styles.
- Keep one solid deep-ink canvas across the safe area and root shell.
- Make the floating navigation and utility-button surfaces opaque so their
  appearance no longer depends on content or decoration behind them.
- Preserve the existing light selected state and primary create button so the
  toolbar hierarchy remains immediately legible.

## Non-Goals

- Reusing the app icon's gradient inside the interface.
- Changing the app icon, typography, navigation structure, screen layouts, task
  cards, terminal, or agent-message presentation.
- Introducing light mode or a user-selectable mobile theme.
- Refactoring every hard-coded mobile color into a comprehensive token system.
- Adding new animation, illustration, or decorative background elements.

## Visual Behavior

Top-level screens render on a uniform `#08111E` canvas. There are no decorative
layers between the canvas and screen content.

The floating toolbar, search button, and navigation container use opaque
`#080F1B` chrome rather than `rgba(...)`. Existing borders and shadows remain, as
they separate controls from the canvas without introducing another decorative
motif. Active navigation items and the create button retain their existing pale
foreground treatment.

Task detail remains unchanged. Its terminal and agent-message surfaces already
own the full viewport and do not render the ambient root decoration visibly.

## Architecture

This is a shell-level presentation change. It stays local to `App.tsx` and
`FloatingToolbar.tsx`; it does not change controller state, navigation models,
data flow, or component APIs. A new global theming abstraction is unnecessary
for this deliberately narrow pass.

## Error Handling

No error behavior changes. Existing error banners continue to render on the
solid canvas with their current contrast and spacing.

## Testing

- Update component assertions only if they explicitly encode the translucent
  toolbar background.
- Run the mobile unit test suite and TypeScript typecheck.
- Manually verify the Tasks, Recent, Search, and More screens at an iPhone-sized
  viewport.
- Confirm the toolbar remains visually distinct and all text, icons, active
  states, and error banners retain sufficient contrast.

## Success Criteria

- No abstract background circles are visible on any top-level mobile screen.
- Top-level screens have a consistent, flat background.
- Floating chrome remains distinct without relying on transparency.
- The task workflow and navigation behavior are unchanged.
