/** Resolve on the next animation frame, or after maxDelayMs if frames are not
 *  ticking. WKWebView stops delivering requestAnimationFrame callbacks while
 *  the window is occluded, minimized, or otherwise not composited — a layout
 *  wait built on a bare rAF promise hangs there forever, which kept terminal
 *  views from ever attaching when the app started without a visible window. */
export function nextFrameOrTimeout(maxDelayMs = 50): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cancelAnimationFrame(rafId)
      resolve()
    }, maxDelayMs)
    const rafId = requestAnimationFrame(() => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    })
  })
}
