# Legacy handoff draft-state constraint (2026-08-16)

The deployed v2 daemon handoff payload does not say whether its live PTY has a
partially composed human draft. After adoption, the PTY master and terminal
snapshot cannot answer that question generically: the draft belongs to the
provider's composer, and recognizing it from rendered terminal state would
require provider-specific prompt parsing. Treating a raw CR/LF byte as proof
of submission is also unsafe because bracketed-paste payloads contain embedded
newlines.

Consequently, a current daemon adopting a payload without the new
`raw_input_draft_state_known` field refuses logical task input with the
observable `inherited_draft_state_unknown` error. It does not acknowledge and
park the message. A producer-declared terminal submission boundary resolves
the ambiguity; the caller can then retry the logical message. This preserves a
real inherited draft and makes the no-draft legacy case fail explicitly rather
than report delivery that may never occur.

The smallest design that permits immediate logical delivery in both legacy
cases is a rolling predecessor that records draft state and emits the field
before any successor relies on it. No safe current-only inference exists. The
cross-version handoff test covers both an empty legacy composer and a real
legacy draft, including successful retry after an explicit boundary.
