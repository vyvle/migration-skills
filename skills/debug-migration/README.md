# Debug Migration Failures - Multi-Agent Diagnostic Skill

## Architecture

This skill demonstrates a **multi-layered agent orchestration** for complex problem diagnosis:

```
┌─────────────────────────────────────────────────────────────┐
│                  User Invocation                            │
│  /debug-migration 10.0.108.50 /tmp/migration.log        │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│                 Workflow Orchestrator                       │
│              (workflow.js - Deterministic)                  │
└─┬───────────────────────────────────────────────────────┬───┘
  │                                                         │
  │ Phase 1: RETRIEVE                                       │
  ├─────────────────────────────────────────────────────────┤
  │  ┌──────────────────────────────────────────┐           │
  │  │  Agent: Log Retrieval                    │           │
  │  │  - SSH to conversion host                │           │
  │  │  - Pull migration.log                    │           │
  │  │  - Extract metadata                      │           │
  │  └──────────────────────────────────────────┘           │
  │                                                         │
  │ Phase 2: ANALYZE (Parallel Specialists)                │
  ├─────────────────────────────────────────────────────────┤
  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
  │  │ Virt-v2v     │  │   NBDKit     │  │   Network    │  │
  │  │ Expert       │  │   Expert     │  │   Expert     │  │
  │  └──────────────┘  └──────────────┘  └──────────────┘  │
  │  ┌──────────────┐  ┌──────────────┐                   │
  │  │     Auth     │  │   Storage    │                   │
  │  │   Expert     │  │   Expert     │                   │
  │  └──────────────┘  └──────────────┘                   │
  │                                                         │
  │  Each agent uses FINDING_SCHEMA for structured output  │
  │                                                         │
  │ Phase 3: RESEARCH (Pipeline per finding)               │
  ├─────────────────────────────────────────────────────────┤
  │  Finding 1 → Research Agent → Solution + KB refs       │
  │  Finding 2 → Research Agent → Solution + KB refs       │
  │  Finding 3 → Research Agent → Solution + KB refs       │
  │  ...                                                    │
  │                                                         │
  │  Each uses WebSearch + WebFetch for KB lookups         │
  │                                                         │
  │ Phase 4: SYNTHESIZE (Single agent)                     │
  ├─────────────────────────────────────────────────────────┤
  │  ┌──────────────────────────────────────────┐           │
  │  │  Synthesis Agent                         │           │
  │  │  - Deduplicate findings                  │           │
  │  │  - Prioritize by severity + ease         │           │
  │  │  - Create action plan                    │           │
  │  │  - Format report (REPORT_SCHEMA)         │           │
  │  └──────────────────────────────────────────┘           │
  │                                                         │
  └─────────────────────┬───────────────────────────────────┘
                        │
                        ▼
        ┌───────────────────────────────────┐
        │    Formatted Report to User       │
        │  - Critical issues with fixes     │
        │  - Warnings with suggestions      │
        │  - KB articles                    │
        │  - Next steps (prioritized)       │
        └───────────────────────────────────┘
```

## Why Multi-Agent?

### 1. **Specialist Expertise**
Each agent has a focused domain (virt-v2v, nbdkit, network, etc.), producing higher quality analysis than a single generalist agent.

### 2. **Parallel Execution** 
All 5 specialist agents run concurrently, analyzing different aspects simultaneously. Much faster than sequential analysis.

### 3. **Structured Output**
JSON schemas enforce consistent, parseable output from each agent. No ambiguous text parsing.

### 4. **Adversarial Verification** (via Research phase)
Research agents independently verify each finding against knowledge bases, catching false positives.

### 5. **Synthesis & Deduplication**
Final synthesis agent combines overlapping findings and prioritizes actions, avoiding information overload.

## Agent Layers

### Layer 1: Retrieval Agent (General Purpose)
- **Task:** Fetch log file via SSH
- **Tools:** Bash (ssh, cat), File I/O
- **Output:** Structured log metadata + content
- **Isolation:** None (read-only operation)

### Layer 2: Specialist Agents (Parallel)
- **Task:** Analyze log for domain-specific failures
- **Tools:** Read (log content), pattern matching
- **Output:** Array of findings (FINDING_SCHEMA)
- **Isolation:** None (read-only, no side effects)
- **Concurrency:** All 5 run in parallel (barrier)

### Layer 3: Research Agents (Pipeline)
- **Task:** Find solutions for each finding
- **Tools:** WebSearch, WebFetch
- **Output:** Solutions with KB references (SOLUTION_SCHEMA)
- **Isolation:** None
- **Concurrency:** Pipeline (finding 1 can be researched while finding 5 is still being analyzed)

### Layer 4: Synthesis Agent (Single)
- **Task:** Create prioritized, actionable report
- **Tools:** None (pure synthesis)
- **Output:** Final report (REPORT_SCHEMA)
- **Isolation:** None

## Workflow Pattern: Barrier vs Pipeline

**Phase 2 (Analyze) - Barrier:**
```javascript
const allFindings = await parallel([
  () => agent('virt-v2v expert', ...),
  () => agent('nbdkit expert', ...),
  () => agent('network expert', ...),
  () => agent('auth expert', ...),
  () => agent('storage expert', ...),
]);
```
✓ Need ALL specialist analyses before proceeding
✓ Barrier ensures we don't miss cross-cutting issues

**Phase 3 (Research) - Pipeline:**
```javascript
const researched = await pipeline(
  findings,
  finding => agent(`Research: ${finding}`, ...)
);
```
✓ Each finding researched independently
✓ No need to wait for all findings before starting research
✓ Better parallelism (research starts as soon as first finding arrives)

## JSON Schemas

The workflow uses **4 structured schemas** to enforce data contracts between agents:

1. **LOG_METADATA_SCHEMA** - Log retrieval output
2. **FINDING_SCHEMA** - Specialist analysis output (array of issues)
3. **SOLUTION_SCHEMA** - Research agent output (solutions + KB refs)
4. **REPORT_SCHEMA** - Final synthesis output (prioritized report)

This eliminates ambiguity and makes the workflow **resumable** (failed agents can retry with cached results).

## Example: How a Finding Flows Through Layers

```
1. Retrieval Agent pulls log:
   "Error: getaddrinfo: Name or service not known (vcenter.example.com)"

2. Network Specialist Agent finds:
   {
     category: "network",
     severity: "critical",
     title: "vCenter DNS resolution failure",
     evidence: "Error: getaddrinfo...",
     root_cause: "Conversion host cannot resolve vCenter hostname"
   }

3. Research Agent searches:
   - Queries: "vcenter dns resolution openstack migration"
   - Finds: GitHub issue #156, RHEL KB article
   - Returns:
   {
     solution_text: "Add vCenter IP to /etc/hosts or configure DNS",
     commands: ["echo '192.168.1.10 vcenter.example.com' | sudo tee -a /etc/hosts"],
     kb_references: ["https://github.com/os-migrate/...#156"],
     confidence: "high"
   }

4. Synthesis Agent prioritizes:
   - Critical severity → top of list
   - Quick fix (5 min) → before longer fixes
   - Formats with exact commands for conversion host
```

## Advantages Over Single Agent

### Single Agent Approach:
```
"Analyze this log and tell me what's wrong"
→ 1 agent does everything
→ May miss domain-specific nuances
→ Long, unstructured response
→ Hard to parse programmatically
```

### Multi-Agent Approach (This Skill):
```
"Analyze this log" → 5 specialists in parallel
→ Deeper domain expertise
→ Structured findings
→ Researched solutions
→ Prioritized action plan
→ Programmatically consumable
```

## Cost vs Value

**Token Cost:** Higher (5-10x more agents than single-agent)
**Time Cost:** Lower (parallel execution)
**Quality:** Significantly higher (specialist expertise + research verification)
**Actionability:** Much higher (structured commands, not vague advice)

**When to use:**
- Production incidents (downtime cost >> token cost)
- Complex multi-domain failures
- Need for high-confidence diagnosis

**When NOT to use:**
- Simple, single-issue failures (use single agent)
- Log is tiny (< 100 lines)
- User wants to explore manually

## Extension Points

### Add New Specialist Agent:
Edit `workflow.js`, add to parallel array:
```javascript
() => agent(
  `You are a [DOMAIN] expert. Analyze for [ISSUES]...`,
  { label: 'new-expert', schema: FINDING_SCHEMA }
)
```

### Add Known Pattern:
Edit `resources/known-patterns.yaml`:
```yaml
- regex: "your.*error.*pattern"
  category: new_category
  severity: critical
  solution: "How to fix it"
```

### Customize Report Format:
Edit REPORT_SCHEMA in `workflow.js` to add fields like:
- `estimated_downtime`
- `affected_vms` (if analyzing multiple VMs)
- `incident_severity` (P0/P1/P2)

## Testing

```bash
# Test with a real failed migration log
/debug-migration 10.0.108.50 /tmp/osm-nbdkit-testvm-abc.log

# Test with SSH user override
/debug-migration 192.168.1.100 /var/log/migration.log root

# Test with non-existent log (should gracefully fail)
/debug-migration 10.0.108.50 /nonexistent.log
```

## Files

```
debug-migration/
├── README.md                    # This file
├── SKILL.md                     # User-facing documentation
├── workflow.js                  # Multi-agent orchestration script
└── resources/
    └── known-patterns.yaml      # Common error patterns and solutions
```

## See Also

- `/vmw-build-prod` - Example of a simple script-based skill (no agents)
- `/deep-research` - Similar multi-agent research pattern
- CLAUDE.md - Project context loaded into all agents
