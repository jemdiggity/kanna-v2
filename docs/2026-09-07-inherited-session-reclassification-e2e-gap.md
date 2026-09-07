# Inherited-session reclassification E2E gap

The protected-input generation recovery crosses the signed production app,
`kanna-server`, daemon handoff, inherited PTY file descriptors, and the desktop
KSP reconnect. The existing real handoff lane cannot currently inject one
`ClassifyInput` refusal between two successful classifications: the refusal is
an authorization/lifecycle race internal to the daemon connection, and the
real daemon deliberately provides no test hook that weakens that boundary.

The real daemon handoff lane now proves that protected-input negotiation by an
authenticated successor reclassifies a fenced, unclassified PTY inherited from
the shipped v2 daemon, and that another handoff and negotiation preserve an
explicitly classified protected fence. A narrower fake-protocol server test
proves a refusal in the middle of the listed PTYs does not prevent the remaining
PTYs from being classified. The desktop lifecycle test repeatedly delivers the
real structured attach refusal and proves one actionable message, one attempt
per increasing backoff interval, and reset to ordinary resize/reconnect behavior
after recovery.

A full E2E becomes practical when the daemon handoff harness can pause and
reject one classification command after authorization while leaving the same
generation and its inherited PTYs alive. That hook must remain test-only and
must not bypass the production peer-identity checks.
