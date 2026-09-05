# Trusted LAN task-file E2E gap

The existing mobile Appium harness exercises mentioned-file resolution and file
preview through the authenticated relay, but its hybrid lane does not provide a
paired-LAN terminal/file fixture or a way to disable the cloud route while
driving the same native journey. Adding that fixture would require extending
the desktop/mobile harness and its task publication setup beyond this routing
fix.

This task therefore adds narrower coverage: paired and unpaired credential
requests are exercised against a real network-bound `kanna-server` in
`paired_lan_client_pages_a_real_task_worktree_fixture`, including task-file
content and mention resolution, and mobile transport/source tests verify the
same headers, owner task identity, hybrid selection, and cloud-disabled path.
The relay Appium lane remains covered by the existing file-preview coverage.
