---
name: audit-docs
description: Test audit of VMK code-to-docs mappings (read-only report)
tags: [docs, audit, vmware-migration-kit]
---

# Audit docs to code

Read-only check of mapping files. Does not edit product repos or open PRs. Writes reports under `reports/` for use by `audit-docs-correctness` (skill 2).

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
   - Set `paths_ok: true` only if all code paths pass and (doc is null OR doc file exists)
4. Build the report data for each row:
   - `id`, `doc`, `doc_exists`, `paths_ok`, `code_ok`, `status`
   - `status`: `mapped` (doc exists, paths OK), `undocumented` (doc null, code OK), `broken` (paths missing)
5. Print a markdown summary table:

   | id | paths OK | doc | status |
   |----|----------|-----|--------|
   | vmk-overview | yes | exists | mapped |
   | vmk-metadata-convert | yes | null | undocumented |

6. **Save reports** (create `reports/` if missing):

   ```
   reports/audit-report-{YYYY-MM-DD}.md
   reports/audit-report-{YYYY-MM-DD}.json
   ```

   Use today's date. If both files already exist for that date, append `-2`, `-3`, etc.

7. Summarize in chat: total mappings, mapped / undocumented / broken counts, and **full paths** to the saved report files

## Report JSON schema

Skill 2 (`audit-docs-correctness`) reads this file. Use this structure:

```json
{
  "audit_id": "2026-07-01-vmware",
  "product": "vmware-migration-kit",
  "generated_at": "2026-07-01T14:00:00Z",
  "code_repo_path": "/expanded/path/to/vmware-migration-kit",
  "docs_repo_path": "/expanded/path/to/documentation",
  "summary": {
    "total": 15,
    "mapped": 12,
    "undocumented": 3,
    "broken": 0
  },
  "mappings": [
    {
      "id": "vmk-overview",
      "paths_ok": true,
      "code_ok": true,
      "doc": "source/operator-vmware-guide.adoc",
      "doc_exists": true,
      "status": "mapped",
      "broken_paths": []
    },
    {
      "id": "vmk-metadata-convert",
      "paths_ok": true,
      "code_ok": true,
      "doc": null,
      "doc_exists": false,
      "status": "undocumented",
      "broken_paths": []
    }
  ]
}
```

The markdown report should contain the same summary table plus a **Next step** line:

```text
Next: /audit-docs-correctness vmware reports/audit-report-{YYYY-MM-DD}.json
```

## Rules

- Read-only on product repos and `config/code-to-docs*.yaml`
- **May write** only to `reports/` under this skill directory
- If a local clone is missing, report which `repos.yaml` path failed and stop (do not write partial reports)
- See `config/README.md` for mapping field meanings

---

# Implementation

You are responsible for executing the steps above when the user invokes `/audit-docs`.

## Autonomous execution

- Run the bundled script immediately. **Do not ask the user questions** or wait for confirmation.
- **Do not** paste scripts for the user to run — execute the command yourself.
- If the script fails, show stderr and stop. Do not ask how to proceed.

From the skill directory (`skills/audit-docs/`), run:

```bash
./scripts/audit-paths.sh vmware
./scripts/audit-paths.sh vmware vmk-migrate-nbdkit
```

The script reads `config/repos.yaml` and `config/code-to-docs.vmware.yaml`, checks paths, and writes reports under `reports/`.

On success, print the script output (summary + `AUDIT_JSON=` / `AUDIT_MD=` lines). Do not re-implement the audit in inline Python.
