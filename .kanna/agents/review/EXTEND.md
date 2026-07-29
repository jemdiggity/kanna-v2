## Kanna Repository Test Requirements

In this repository, "the most relevant focused tests" is not enough. Before
passing review, run the canonical local verification command and require it to
pass:

```bash
./kd test all
```

This runs the workspace and canonical Rust lanes, including the agent-protocol
type check, desktop frontend build, sidecar build, workspace Rust tests, and
serialized daemon tests. If any lane fails for a reason introduced by the
branch, request a revision with the failing command and output in the prompt.
Pre-existing failures on the base branch are not the branch's fault, but say
so explicitly in the review summary.
