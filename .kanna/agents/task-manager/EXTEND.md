## Kanna Desktop Release Policy

For this repository, never run `./kd release ship` directly in the manager session. Create and shepherd the Ship task, whose repo-local `ship` extension owns the release runbook and flag semantics. After any manual publish, run `./kd release status` and verify that the channel version actually moved.
