# Diff Scrollbar Gutter Design

## Goal

Keep the diff view's vertical scrollbar unobscured when a long diff is rendered in the regular diff modal.

## Root Cause

The actual vertical scroller is `.diff-container` in `DiffContentPane.vue`. In Kanna's macOS WKWebView, the native overlay scrollbar consumes no layout width. A rendered `.diff-file` therefore reaches the exact inline-end edge of the scroller and paints beneath the scrollbar.

A live reproduction measured both the scroll container and rendered file at 1,078 px wide, with `offsetWidth - clientWidth` equal to zero. Setting `scrollbar-gutter: stable` or custom WebKit scrollbar width did not reserve space in this environment.

## Design

Reserve a 12 px inline-end lane inside `.diff-container`:

```css
.diff-container {
  box-sizing: border-box;
  padding-inline-end: 12px;
}
```

The logical padding property keeps the fix direction-aware. Border-box sizing keeps the scroll container within its existing flex layout. Rendered file wrappers and sticky file headers then end before the overlay scrollbar lane without changing diff loading, rendering, horizontal scrolling, or persisted vertical scroll positions.

No JavaScript state or renderer integration is required. The existing `.diff-container` continues to own persisted diff scroll state.

## Alternatives Considered

- `scrollbar-gutter: stable` is the standards-oriented option, but WKWebView accepted the property without reserving space for its overlay scrollbar.
- Custom `::-webkit-scrollbar` sizing and track styles remained overlay-only and did not create a protected content lane.
- Adding margins to each generated `.diff-file` would couple the layout fix to renderer-generated children and would be easier to miss for future empty, skipped, or alternate content.

## Error Handling

The change is CSS-only and adds no new failure modes. Existing diff loading errors and empty states remain unchanged.

## Testing

Add a WebDriver E2E regression around a long rendered diff. The test will verify that:

- `.diff-container` has vertical overflow;
- its inline-end padding is 12 px; and
- the rendered `.diff-file` right edge remains at least 12 px inside the container's right edge.

The test must fail against the current layout before the CSS change is applied, then pass after the fix. Run the focused diff-view E2E coverage and the desktop component tests relevant to `DiffView`.

## Non-Goals

- Redesigning scrollbar appearance.
- Changing the review comments drawer.
- Refactoring diff renderer ownership or scroll persistence.
