# Mobile OTA Release Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Document that agents may mutate the staging OTA channel while production OTA publication and rollback require explicit human approval.

**Architecture:** Keep the authorization policy in the canonical `AGENTS.md` Mobile OTA section beside the publish and rollback workflows. This is documentation-only; KD behavior, IAM, and cloud state remain unchanged.

**Tech Stack:** Markdown, Git

---

### Task 1: Document the OTA authorization boundary

**Files:**
- Modify: `AGENTS.md:293`
- Reference: `docs/superpowers/specs/2026-07-19-mobile-ota-release-authorization-design.md`

- [ ] **Step 1: Add the approved policy to the canonical OTA section**

Insert this paragraph after the provisioning paragraph and before the deploy/publish instructions:

```markdown
Agents may publish or roll back the staging OTA channel through the canonical `./kd mobile ota publish --staging` workflow without additional human approval. Publishing or rolling back the production OTA channel requires explicit human approval for that operation. Read-only production `status` and `doctor` checks do not require approval.
```

- [ ] **Step 2: Verify policy coverage and formatting**

Run:

```bash
rg -n "Agents may publish or roll back the staging OTA channel|production OTA channel requires explicit human approval|Read-only production" AGENTS.md
git diff --check
```

Expected: all three policy clauses appear in the Mobile OTA section, and `git diff --check` exits with no output.

- [ ] **Step 3: Commit the documentation change**

```bash
git add AGENTS.md docs/superpowers/plans/2026-07-19-mobile-ota-release-authorization.md
git commit -m "docs: define mobile OTA release authorization"
```
