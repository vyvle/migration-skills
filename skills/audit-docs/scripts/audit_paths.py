#!/usr/bin/env python3
"""Path audit for code-to-docs mappings. Writes JSON + Markdown reports."""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError:
    print("error: PyYAML required (pip install pyyaml)", file=sys.stderr)
    sys.exit(1)

PRODUCT_MAP = {
    "vmware": "code-to-docs.vmware.yaml",
    "vmk": "code-to-docs.vmware.yaml",
}

CODE_REPO_KEY = {
    "vmware": "vmware-migration-kit",
    "vmk": "vmware-migration-kit",
}


def skill_dir() -> Path:
    return Path(__file__).resolve().parent.parent


def expand(path: str) -> Path:
    return Path(os.path.expanduser(path)).resolve()


def load_yaml(path: Path) -> Any:
    with path.open(encoding="utf-8") as f:
        return yaml.safe_load(f)


def check_code_path(code_repo: Path, code_path: str) -> tuple[bool, str | None]:
    if "**" in code_path:
        pattern = str(code_repo / code_path)
        matches = glob.glob(pattern, recursive=True)
        if matches:
            return True, None
        base = code_path.split("/**")[0]
        base_full = code_repo / base
        if not base_full.is_dir():
            return False, str(base_full)
        return False, pattern
    full = code_repo / code_path
    if full.is_file():
        return True, None
    return False, str(full)


def audit_mapping(code_repo: Path, docs_repo: Path, mapping: dict) -> dict:
    broken_paths: list[str] = []
    code_ok = True
    for cp in mapping.get("code") or []:
        ok, broken = check_code_path(code_repo, cp)
        if not ok:
            code_ok = False
            if broken:
                broken_paths.append(broken)

    doc = mapping.get("doc")
    doc_exists = False
    if doc is not None:
        doc_full = docs_repo / doc
        doc_exists = doc_full.is_file()
        if not doc_exists:
            broken_paths.append(str(doc_full))

    if not code_ok:
        status = "broken"
    elif doc is None:
        status = mapping.get("status") or "undocumented"
    elif doc_exists and code_ok:
        status = "mapped"
    else:
        status = "broken"

    paths_ok = code_ok and (doc is None or doc_exists)

    return {
        "id": mapping["id"],
        "paths_ok": paths_ok,
        "code_ok": code_ok,
        "doc": doc,
        "doc_exists": doc_exists,
        "status": status,
        "broken_paths": broken_paths,
    }


def pick_report_paths(reports_dir: Path, date_str: str) -> tuple[Path, Path]:
    base = f"audit-report-{date_str}"
    suffix = ""
    n = 1
    while True:
        json_path = reports_dir / f"{base}{suffix}.json"
        if not json_path.exists():
            md_path = reports_dir / f"{base}{suffix}.md"
            return json_path, md_path
        n += 1
        suffix = f"-{n}"


def write_markdown(path: Path, report: dict, rel_json: str) -> None:
    summary = report["summary"]
    lines = [
        f"# Audit report — {report['product']} ({report['audit_id']})",
        "",
        f"Generated: {report['generated_at']}",
        "",
        "## Summary",
        "",
        f"- Total mappings: {summary['total']}",
        f"- Mapped: {summary['mapped']}",
        f"- Undocumented: {summary['undocumented']}",
        f"- Broken: {summary['broken']}",
        "",
        "## Mappings",
        "",
        "| id | paths OK | doc | status |",
        "|----|----------|-----|--------|",
    ]
    for r in report["mappings"]:
        paths = "yes" if r["paths_ok"] else "no"
        if r["doc_exists"]:
            doc_col = "exists"
        elif r["doc"] is None:
            doc_col = "null"
        else:
            doc_col = "missing"
        lines.append(f"| {r['id']} | {paths} | {doc_col} | {r['status']} |")

    if summary["broken"] > 0:
        lines.extend(["", "## Broken paths", ""])
        for r in report["mappings"]:
            if r["broken_paths"]:
                lines.append(f"### {r['id']}")
                for bp in r["broken_paths"]:
                    lines.append(f"- `{bp}`")

    lines.extend(
        [
            "",
            "## Next step",
            "",
            f"Next: /audit-docs-correctness vmware {rel_json}",
            "",
        ]
    )
    path.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit code-to-docs path mappings")
    parser.add_argument("product", choices=sorted(PRODUCT_MAP.keys()), help="e.g. vmware")
    parser.add_argument("id", nargs="?", help="optional mapping id filter")
    args = parser.parse_args()

    root = skill_dir()
    config_dir = root / "config"
    reports_dir = root / "reports"
    reports_dir.mkdir(parents=True, exist_ok=True)

    repos = load_yaml(config_dir / "repos.yaml")
    map_file = config_dir / PRODUCT_MAP[args.product]
    map_data = load_yaml(map_file)

    code_key = CODE_REPO_KEY[args.product]
    code_repo = expand(repos["code_repos"][code_key]["local_path"])
    docs_repo = expand(repos["docs_repo"]["local_path"])

    if not code_repo.is_dir():
        print(f"error: code repo not found: {code_repo}", file=sys.stderr)
        return 1
    if not docs_repo.is_dir():
        print(f"error: docs repo not found: {docs_repo}", file=sys.stderr)
        return 1

    mappings = map_data.get("mappings") or []
    if args.id:
        mappings = [m for m in mappings if m.get("id") == args.id]
        if not mappings:
            print(f"error: mapping id not found: {args.id}", file=sys.stderr)
            return 1

    results = [audit_mapping(code_repo, docs_repo, m) for m in mappings]
    summary = {
        "total": len(results),
        "mapped": sum(1 for r in results if r["status"] == "mapped"),
        "undocumented": sum(1 for r in results if r["status"] == "undocumented"),
        "broken": sum(1 for r in results if r["status"] == "broken"),
    }

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    json_path, md_path = pick_report_paths(reports_dir, today)
    rel_json = f"reports/{json_path.name}"

    report = {
        "audit_id": f"{today}-{args.product}",
        "product": map_data.get("product") or code_key,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "code_repo_path": str(code_repo),
        "docs_repo_path": str(docs_repo),
        "summary": summary,
        "mappings": results,
    }

    json_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    write_markdown(md_path, report, rel_json)

    print(f"AUDIT_JSON={json_path}")
    print(f"AUDIT_MD={md_path}")
    print(
        f"SUMMARY total={summary['total']} mapped={summary['mapped']} "
        f"undocumented={summary['undocumented']} broken={summary['broken']}"
    )
    for r in results:
        paths = "yes" if r["paths_ok"] else "no"
        doc_col = "exists" if r["doc_exists"] else ("null" if r["doc"] is None else "missing")
        print(f"ROW {r['id']}|{paths}|{doc_col}|{r['status']}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
