---
name: audit-docs
description: Test audit of VMK code-to-docs mappings (read-only report)
tags: [docs, audit, vmware-migration-kit]
---

# Audit docs to code

Read-only check of mapping files. Does not edit repos or open PRs.

All paths below are relative to this skill directory (`skills/audit-docs/`).

## Usage

```
/audit-docs vmware
/audit-docs vmware vmk-migrate-nbdkit
```

**Arguments:**
- `vmware` (required) — check entries in `config/code-to-docs.vmware.yaml`
- `id` (optional) — audit a single mapping by `id` (e.g. `vmk-migrate-nbdkit`)

## Prerequisites

- Local clones at paths defined in `config/repos.yaml`
- Install skill for Claude Code: `./scripts/install.sh --symlink` from repo root

## Steps

1. Read `config/repos.yaml` and resolve local paths (expand `~`):
   - Code: `code_repos.vmware-migration-kit.local_path`
   - Docs: `docs_repo.local_path`
2. Read `config/code-to-docs.vmware.yaml`
3. For each mapping (or the one `id` if provided):
   - Verify each `code:` path under the VMK repo root:
     - Single file: file must exist
     - Glob (`**`): base directory must exist with at least one matching file
   - If `doc` is not null, verify the path exists under the documentation repo root
   - If `doc` is null, list as **undocumented** (use `status` from mapping if set)
4. Output a markdown report:

   | id | code OK | doc | status |
   |----|---------|-----|--------|
   | vmk-overview | yes | exists | mapped |
   | vmk-metadata-convert | yes | null | undocumented |

5. Summarize: total mappings, documented count, gaps, broken paths

## Rules

- Read-only — do not modify mapping files or product repos
- If a local clone is missing, report which `repos.yaml` path failed and stop
- See `config/README.md` for mapping field meanings

---

# Implementation

You are responsible for executing the steps above when the user invokes `/audit-docs`.

Use shell commands (`test`, `ls`, `find`) to verify paths rather than guessing. Report broken paths with the full resolved filesystem path.
