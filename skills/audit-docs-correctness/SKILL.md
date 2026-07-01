---
name: audit-docs-correctness
description: Compare documented VMK code against documentation content; suggest fixes only (read-only)
tags: [docs, audit, vmware-migration-kit, correctness]
---

# Audit docs correctness

Compares **documented** code areas against what the docs say. **Read-only** — no edits to code, docs, mapping files, or PRs. Outputs a report with suggested fixes only.

Runs after `audit-docs` (skill 1) or standalone if paths are already known good.

Shared config lives in `../audit-docs/config/`. Paths below are relative to this skill directory (`skills/audit-docs-correctness/`).

## Usage

```
/audit-docs-correctness vmware
/audit-docs-correctness vmware ../audit-docs/reports/audit-report-2026-07-01.json
/audit-docs-correctness vmware vmk-migrate-nbdkit
/audit-docs-correctness vmware ../audit-docs/reports/audit-report-2026-07-01.json vmk-migrate-nbdkit
```

**Arguments:**
- `vmware` (required) — use `../audit-docs/config/code-to-docs.vmware.yaml`
- `report.json` (optional) — audit report from skill 1; only check rows with `paths_ok: true` and `status: mapped`
- `id` (optional) — single mapping id (e.g. `vmk-migrate-nbdkit`)

## Prerequisites

- Local clones at paths in `../audit-docs/config/repos.yaml`
- Run `audit-docs` first (recommended) or ensure code/doc paths exist
- Install for Claude Code: `./scripts/install.sh --symlink` from repo root

## Which rows to check

Include a mapping only if **all** are true:

- `doc` is not null
- Code and doc files exist (from report or verified now)
- Not `status: undocumented`

Skip rows with `doc: null`. If a report is provided, skip rows where `paths_ok` is false.

## Steps

### 1. Load inputs

1. Read `../audit-docs/config/repos.yaml` and resolve paths (expand `~`):
   - Code: `code_repos.vmware-migration-kit.local_path`
   - Docs: `docs_repo.local_path`
   - Docs URL: `docs_repo.url` (for report links; default branch `main`)
2. Read `../audit-docs/config/code-to-docs.vmware.yaml`
3. If `report.json` given, read it and filter eligible rows; else use all mapped rows from the YAML

### 2. Compare doc vs code (by `kind`)

For each eligible mapping, read the mapped doc file and related code. Use `notes` on the mapping for section focus when present.

**playbook**
- Collection FQCN in doc matches `galaxy.yml` (`namespace`, `name`)
- Playbook referenced in doc (e.g. `os_migrate.vmware_migration_kit.migration`) matches a file under `playbooks/`
- Sub-playbooks imported by `playbooks/migration.yml` still exist if doc describes end-to-end flow

**role / feature**
- Variable names in doc examples exist in related role `defaults/main.yml`, playbooks, or role `README.md`
- Important user-facing defaults in code are reflected in doc (warning if missing from doc, not auto-fail)
- Doc mentions a variable name with no match in code → **issue**

**module**
- Parse `DOCUMENTATION` / `options:` from the module `.py`
- Required options missing from doc → **warning**
- Doc-only option names with no module match → **issue**

**ci / internal**
- Doc describes workflows or paths that exist under mapped `code:` globs

### 3. Classify each row

| Result | Meaning |
|--------|---------|
| **ok** | No meaningful mismatches |
| **warnings** | Minor gaps (undocumented vars, missing optional detail) |
| **issues** | Wrong names, stale examples, clear doc/code conflict |

Record **evidence** for every warning/issue: file path, **line number**, and quote from doc and code.

Always include the doc line number in findings (e.g. `operator-vmware-guide.adoc line 331`).

### 3b. Doc link (per row)

Build a GitHub source link for the markdown `doc` column:

```
{docs_repo.url}/blob/main/{doc_path}#L{line}
```

| Row | `doc_line` | Markdown `doc` column |
|-----|------------|------------------------|
| **issues** / **warnings** | First line cited in findings | `[basename:331](url#L331)` |
| **ok** | Omit | `[basename](url)` (file only, no `#L`) |

Example:

```markdown
[operator-vmware-guide.adoc:331](https://github.com/os-migrate/documentation/blob/main/source/operator-vmware-guide.adoc#L331)
```

When a row has multiple doc lines, link to the **first** issue line; list the rest in `findings` only.

### 4. Suggest fixes (text only)

For **warnings** and **issues**, add a `suggested_fix` field:

- Describe what to change in the doc (not the code)
- Quote the doc snippet to replace or extend
- Do **not** apply edits — suggestions only

For **ok** rows, add a one-line confirmation to the report summary.

### 5. Write report

Print markdown and save to:

```
../audit-docs/reports/correctness-report-{YYYY-MM-DD}.md
../audit-docs/reports/correctness-report-{YYYY-MM-DD}.json
```

**Markdown table** — `doc` column must be a markdown link (not a bare path):

| id | correctness | doc | findings | suggested_fix |
|----|-------------|-----|----------|---------------|
| vmk-conversion-host | issues | [operator-vmware-guide.adoc:331](https://github.com/os-migrate/documentation/blob/main/source/operator-vmware-guide.adoc#L331) | Doc var `conversion_host_vmware_vix_disklib` not in code | Rename to `conversion_host_vmware_lib_dir` in VDDK example |
| vmk-overview | ok | [operator-vmware-guide.adoc](https://github.com/os-migrate/documentation/blob/main/source/operator-vmware-guide.adoc) | FQCN matches galaxy.yml | |

**JSON shape (per row):**

```json
{
  "id": "vmk-conversion-host",
  "correctness": "ok|warnings|issues",
  "doc": "source/operator-vmware-guide.adoc",
  "doc_line": 331,
  "doc_url": "https://github.com/os-migrate/documentation/blob/main/source/operator-vmware-guide.adoc#L331",
  "findings": ["..."],
  "suggested_fix": "..."
}
```

- `doc_line`: first cited line for issues/warnings; omit for `ok`
- `doc_url`: full GitHub URL; include `#L{line}` when `doc_line` is set

Omit or empty `suggested_fix` when `correctness` is `ok`.

### 6. Summarize

- Total checked, ok / warnings / issues counts
- List ids with **issues** first, then **warnings**
- Remind: this run did not modify any repository

## Rules

- **Read-only** — do not modify code repo, documentation repo, or `code-to-docs*.yaml`
- **No PRs** — do not create branches or pull requests
- **No auto-fix** — suggest fixes in the report only; human applies changes
- Skip `doc: null` / undocumented mappings
- Many rows may share one `.adoc` file — report per **mapping id**, not “whole file wrong”
- Cite evidence; do not guess — read files with shell or read tool
- If clones missing, report failed path and stop
- See `../audit-docs/config/README.md` for mapping field meanings

---

# Implementation

You are responsible for executing the steps above when the user invokes `/audit-docs-correctness`.

Use `rg`, `grep`, and file reads to compare names and examples. Prefer narrow context: only files listed in the mapping's `code:` and the single `doc:` file.

When the same doc file appears in multiple mappings, check only what is relevant to that mapping's code paths and `notes`.

Build `doc_url` from `docs_repo.url` in `repos.yaml` — do not hardcode a different org or branch unless the user specifies one.
