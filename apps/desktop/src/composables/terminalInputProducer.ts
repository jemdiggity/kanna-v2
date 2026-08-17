export type TerminalProducerInputKind = "draft" | "submission" | "control"

type CompositionState = "idle" | "active" | "commit-pending"

export interface TerminalInputClassification {
  submissionBoundary: boolean
  controlInput: boolean
}

function isUnmodifiedEnter(event: KeyboardEvent): boolean {
  return event.key === "Enter"
    && !event.shiftKey
    && !event.altKey
    && !event.ctrlKey
    && !event.metaKey
}

function xtermContinuesComposition(event: KeyboardEvent): boolean {
  return event.keyCode === 20
    || event.keyCode === 229
    || event.keyCode === 16
    || event.keyCode === 17
    || event.keyCode === 18
}

/**
 * Tracks which browser producer caused xterm's next `onData` emission.
 *
 * xterm calls its custom key handler before `CompositionHelper.keydown()`. A
 * key that finalizes an active composition can therefore emit both the
 * committed composition and the key's own bytes synchronously after the
 * handler returns. Those emissions share one draft classification; ordinary
 * producers remain one-shot so an unrelated parser reply stays control input.
 */
export function createTerminalInputProducerClassifier() {
  let producerInputKind: TerminalProducerInputKind = "control"
  let producerInputGeneration = 0
  let reuseProducerForCurrentKeydown = false
  let compositionState: CompositionState = "idle"
  let compositionGeneration = 0

  const declareProducerInput = (
    kind: TerminalProducerInputKind,
    reuseForCurrentKeydown = false,
  ) => {
    producerInputKind = kind
    reuseProducerForCurrentKeydown = reuseForCurrentKeydown
    const generation = ++producerInputGeneration
    queueMicrotask(() => {
      if (producerInputGeneration !== generation) return
      producerInputKind = "control"
      reuseProducerForCurrentKeydown = false
    })
  }

  const markCompositionCommitPending = () => {
    compositionState = "commit-pending"
    compositionGeneration += 1
  }

  const handleCompositionStart = () => {
    compositionState = "active"
    compositionGeneration += 1
    declareProducerInput("draft")
  }

  const handleCompositionUpdate = () => {
    compositionState = "active"
    compositionGeneration += 1
    declareProducerInput("draft")
  }

  const handleCompositionEnd = () => {
    markCompositionCommitPending()
    const generation = compositionGeneration

    // CompositionHelper queues its commit in setTimeout(0) from the target's
    // compositionend listener. This capture listener runs first. Queue the
    // empty-commit fallback only after xterm has installed that timer; a real
    // commit clears the explicit pending state in classifyData instead.
    queueMicrotask(() => setTimeout(() => {
      if (
        compositionGeneration === generation
        && compositionState === "commit-pending"
      ) {
        compositionState = "idle"
      }
    }, 0))
  }

  const handleKeyEvent = (event: KeyboardEvent) => {
    if (event.type !== "keydown") return

    const compositionInProgress = compositionState !== "idle" || event.isComposing
    if (compositionInProgress) {
      if (!xtermContinuesComposition(event)) {
        // CompositionHelper finalizes synchronously after this handler, then
        // may emit the key itself. Both emissions belong to the draft. In
        // particular, the Enter that commits an IME candidate is not also a
        // submission boundary.
        markCompositionCommitPending()
        declareProducerInput("draft", true)
      } else {
        // keyCode 229 (the IME process key) and modifiers are swallowed by
        // CompositionHelper and leave the composition lifecycle in control.
        if (compositionState === "idle") {
          compositionState = "active"
          compositionGeneration += 1
        }
        declareProducerInput("draft")
      }
      return
    }

    declareProducerInput(isUnmodifiedEnter(event) ? "submission" : "draft")
  }

  const classifyData = (): TerminalInputClassification => {
    let inputKind = producerInputKind
    if (compositionState === "active") {
      inputKind = "draft"
    } else if (compositionState === "commit-pending") {
      inputKind = "draft"
      compositionState = "idle"
      compositionGeneration += 1
    }

    if (!reuseProducerForCurrentKeydown) {
      producerInputKind = "control"
      producerInputGeneration += 1
    }

    return {
      submissionBoundary: inputKind === "submission",
      controlInput: inputKind === "control",
    }
  }

  return {
    classifyData,
    declareControlInput: () => declareProducerInput("control"),
    declareDraftInput: () => declareProducerInput("draft"),
    handleCompositionEnd,
    handleCompositionStart,
    handleCompositionUpdate,
    handleKeyEvent,
  }
}
