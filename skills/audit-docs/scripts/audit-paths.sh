#!/usr/bin/env bash
set -euo pipefail

# VMware / product path audit for code-to-docs mappings.
# Usage: ./scripts/audit-paths.sh vmware [mapping-id]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

exec python3 "${SCRIPT_DIR}/audit_paths.py" "$@"
