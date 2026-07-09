# Review Inbox Sidebar Badge E2E Gap

The review-inbox sidebar badge is covered by unit tests for the derived
awaiting-verdict predicate and by a Sidebar component test for rendering the
badge on a parked manual-stage task.

The existing native-review mock E2E coverage parks a task at `review` to verify
diff comments, request-changes, and approve action wiring. It does not create or
drive a task parked at `pr` in the sidebar, so there is no stable parked-at-pr
fixture to extend for a sidebar badge assertion yet.
