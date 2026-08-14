# Public Repo Config Schema

## Problem

Kanna supports a repository-level `.kanna/config.json`, but there is no published JSON Schema for it.

That creates two problems:

- agents generating `.kanna/config.json` on user machines have no stable contract to follow
- editors and tools cannot provide schema-backed guidance, completion, and validation from a canonical source

The current source of truth is only the hand-written parser in `packages/core/src/config/repo-config.ts`. That parser is useful for runtime behavior, but it is not directly consumable by agents or editors on arbitrary user machines.

## Goal

Publish a stable JSON Schema for `.kanna/config.json` that agents can reference while generating configs on user machines, while keeping runtime config parsing unchanged.

## Non-Goals

- Replacing `parseRepoConfig()` with schema-driven runtime validation
- Rejecting invalid configs at runtime based on JSON Schema
- Designing a generic schema publishing framework for all Kanna config files
- Expanding the supported `.kanna/config.json` surface beyond what the current parser already supports

## Canonical Contract

The canonical public schema URL will be:

`https://schemas.kanna.build/config.schema.json`

Generated or checked-in `.kanna/config.json` files should reference that URL with:

```json
{
  "$schema": "https://schemas.kanna.build/config.schema.json"
}
```

The repo will also keep a checked-in source copy at:

`/.kanna/config.schema.json`

The checked-in repo copy is the maintained source artifact. GitHub Pages will publish that same artifact at the canonical public URL.

## Proposed Change

Add a strict JSON Schema that describes the currently supported repo config shape:

- `$schema: string` for instance-side schema self-reference
- `workflow: string`
- `setup: string[]`
- `teardown: string[]`
- `test: string[]`
- `ports: { [envName: string]: integer }`
- `stage_order: string[]`
- `workspace`
  - `env: { [envName: string]: string }`
  - `path`
    - `prepend: string[]`
    - `append: string[]`

The schema will be editor- and agent-facing only. Runtime behavior remains governed by `parseRepoConfig()`.

## Design Details

### Schema File

Create `.kanna/config.schema.json` with:

- `$schema` pointing at the JSON Schema draft used by the file itself
- `$id` set to `https://schemas.kanna.build/config.schema.json`
- `title` and `description` that identify it as the Kanna repo config schema
- `type: "object"`
- `additionalProperties: false` at the top level

The schema must allow an optional top-level `"$schema"` string property so `.kanna/config.json` can reference the canonical public schema URL and still validate against the schema.

Nested strictness:

- `workspace` uses `additionalProperties: false`
- `workspace.path` uses `additionalProperties: false`
- `ports` allows arbitrary property names, but values must be integers
- `workspace.env` allows arbitrary property names, but values must be strings

This mirrors current parser support while discouraging unsupported keys.

### Examples

Include a few small schema examples as annotations, not as extra pseudo-documentation.

Examples should show:

- a minimal config with `setup` and `ports`
- a config using `workspace.path.prepend`
- a config using `workspace.env`

Examples exist to help agents and editors infer intended structure more deterministically.

### Checked-In Config

Update `.kanna/config.json` to include:

```json
"$schema": "https://schemas.kanna.build/config.schema.json"
```

This makes the repo’s own config a living example and ensures editors resolve the public schema during local development.

### GitHub Pages Publishing

GitHub Pages will serve the checked-in schema file as the public artifact.

Publishing model:

- source artifact in repo: `.kanna/config.schema.json`
- deployed artifact: `https://schemas.kanna.build/config.schema.json`

The deployment path should not introduce a second hand-maintained schema copy. The published file must come from the checked-in source artifact so review, version control, and publication stay aligned.

### Domain and URL Shape

Use the custom domain:

`schemas.kanna.build`

Serve the schema at the root path:

`/config.schema.json`

This keeps the URL short, stable, and easy for agents to reproduce.

### Runtime Boundary

The parser in `packages/core/src/config/repo-config.ts` remains the runtime authority.

That boundary is intentional:

- the schema exists for generation and guidance
- the parser exists for runtime interpretation

This keeps the current runtime architecture intact and avoids coupling app behavior to editor-facing schema validation in the first version.

## Verification

Add verification that covers:

- `.kanna/config.schema.json` exists
- the schema declares the supported top-level keys and strict object behavior
- `.kanna/config.json` references `https://schemas.kanna.build/config.schema.json`
- Pages publishing serves the checked-in schema artifact, not a divergent copy

Verification should stay practical. It does not need to prove semantic equivalence between the parser and schema in one pass, but it should catch obvious drift in supported keys and deployment wiring.

## Risks

- schema drift from `parseRepoConfig()` if future config fields update one artifact but not the other
- overly strict schema settings could block experimentation if users try unsupported keys intentionally
- Pages deployment wiring could accidentally publish stale or copied content if the workflow is not source-of-truth driven

## Recommendation

Implement the smallest durable contract:

- add `.kanna/config.schema.json`
- reference `https://schemas.kanna.build/config.schema.json` from `.kanna/config.json`
- publish the checked-in schema through GitHub Pages on `schemas.kanna.build`
- keep runtime parsing unchanged

This gives agents on user machines a stable public schema immediately without forcing a broader parser/validation refactor.
