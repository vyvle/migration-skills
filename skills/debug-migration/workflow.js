export const meta = {
  name: 'debug-migration',
  description: 'Multi-agent analysis of VMware migration log failures with knowledge base research',
  phases: [
    { title: 'Retrieve', detail: 'Pull migration log from conversion host' },
    { title: 'Analyze', detail: 'Parallel expert agents examine failure modes' },
    { title: 'Research', detail: 'Search knowledge bases for known solutions' },
    { title: 'Synthesize', detail: 'Combine findings and create action plan' },
  ],
};

// JSON Schemas for structured output from agents
const LOG_METADATA_SCHEMA = {
  type: 'object',
  properties: {
    vm_name: { type: 'string' },
    timestamp: { type: 'string' },
    log_size_bytes: { type: 'number' },
    line_count: { type: 'number' },
    contains_errors: { type: 'boolean' },
    log_content: { type: 'string' },
  },
  required: ['vm_name', 'log_content', 'contains_errors'],
};

const FINDING_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: ['virt-v2v', 'nbdkit', 'network', 'authentication', 'storage', 'permissions', 'performance', 'other']
          },
          severity: {
            type: 'string',
            enum: ['critical', 'warning', 'info']
          },
          title: { type: 'string' },
          evidence: { type: 'string' },
          line_numbers: { type: 'array', items: { type: 'number' } },
          root_cause: { type: 'string' },
        },
        required: ['category', 'severity', 'title', 'evidence', 'root_cause'],
      },
    },
  },
  required: ['findings'],
};

const SOLUTION_SCHEMA = {
  type: 'object',
  properties: {
    issue: { type: 'string' },
    solutions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          solution_text: { type: 'string' },
          commands: { type: 'array', items: { type: 'string' } },
          kb_references: { type: 'array', items: { type: 'string' } },
          estimated_time: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['solution_text', 'confidence'],
      },
    },
  },
  required: ['issue', 'solutions'],
};

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'object',
      properties: {
        vm_name: { type: 'string' },
        total_issues: { type: 'number' },
        critical_count: { type: 'number' },
        warning_count: { type: 'number' },
      },
    },
    critical_issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          category: { type: 'string' },
          evidence: { type: 'string' },
          root_cause: { type: 'string' },
          solution: { type: 'string' },
          commands: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    warnings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          impact: { type: 'string' },
          suggestions: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    kb_articles: { type: 'array', items: { type: 'string' } },
    next_steps: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'critical_issues', 'warnings', 'next_steps'],
};

// Workflow execution
phase('Retrieve');

// Parse arguments: conversion_host, log_path, ssh_user (optional)
const [conversionHost, logPath, sshUser = 'cloud-user'] = args || [];

if (!conversionHost || !logPath) {
  throw new Error('Usage: /debug-migration <conversion-host-ip> <log-path> [ssh-user]');
}

log(`Connecting to ${sshUser}@${conversionHost}`);
log(`Retrieving log: ${logPath}`);

// Agent 1: Pull the log file from conversion host
const logData = await agent(
  `SSH to ${sshUser}@${conversionHost} and retrieve the migration log file at ${logPath}.

   Use Bash tool to:
   1. Test SSH connectivity: ssh ${sshUser}@${conversionHost} "echo SSH_OK"
   2. Check if log file exists: ssh ${sshUser}@${conversionHost} "ls -lh ${logPath}"
   3. Pull the log: ssh ${sshUser}@${conversionHost} "cat ${logPath}" > /tmp/migration-log-retrieval.txt
   4. Store locally at /tmp/migration-diagnosis-${Date.now()}/migration.log
   5. Extract metadata: VM name, timestamp, size, line count

   Return the full log content and metadata.

   If SSH fails, return error details.
   If log file doesn't exist, list files in the directory to help locate it.`,
  {
    label: 'retrieve-log',
    phase: 'Retrieve',
    schema: LOG_METADATA_SCHEMA,
  }
);

if (!logData || !logData.log_content) {
  throw new Error('Failed to retrieve log file. Check SSH access and log path.');
}

log(`Retrieved ${logData.line_count || 'unknown'} lines from ${logData.vm_name || 'VM'}`);

// Phase 2: Parallel analysis by specialist agents
phase('Analyze');

log('Launching specialist agents for multi-dimensional analysis...');

const allFindings = await parallel([
  // Virt-v2v specialist
  () => agent(
    `You are a virt-v2v expert. Analyze this migration log for virt-v2v specific failures:

    ${logData.log_content}

    Look for:
    - Filesystem conversion errors (BTRFS, LVM, XFS compatibility)
    - Driver injection failures (virtio drivers, Windows drivers)
    - Guest tools issues (VMware Tools, virtio-win)
    - OS-specific problems (Windows activation, Linux kernel issues)
    - Disk format incompatibilities

    For each issue found, provide:
    - Exact error evidence from log (quote the line)
    - Root cause analysis
    - Severity (critical/warning/info)

    Focus on actionable findings only.`,
    {
      label: 'virt-v2v-expert',
      phase: 'Analyze',
      schema: FINDING_SCHEMA,
    }
  ),

  // NBDKit specialist
  () => agent(
    `You are an NBDKit and VDDK expert. Analyze this migration log for nbdkit failures:

    ${logData.log_content}

    Look for:
    - NBDKit server crashes or hangs
    - VDDK plugin errors
    - Disk streaming connection failures
    - Timeout errors during transfer
    - Socket/pipe errors
    - Memory issues or resource exhaustion

    For each issue found, provide:
    - Exact error evidence from log
    - Root cause (why nbdkit failed)
    - Severity assessment

    Ignore issues clearly not related to nbdkit.`,
    {
      label: 'nbdkit-expert',
      phase: 'Analyze',
      schema: FINDING_SCHEMA,
    }
  ),

  // Network specialist
  () => agent(
    `You are a network troubleshooting expert. Analyze this migration log for network issues:

    ${logData.log_content}

    Look for:
    - DNS resolution failures (vCenter, ESXi hosts)
    - Connection timeouts
    - Port blocking (443/TCP vCenter, 902/TCP ESXi)
    - SSL/TLS certificate errors
    - Network unreachable errors
    - Firewall blocking
    - Proxy issues

    For each issue found, provide:
    - Exact error evidence
    - Which component cannot reach which target
    - Severity

    Be specific about IPs, hostnames, and ports involved.`,
    {
      label: 'network-expert',
      phase: 'Analyze',
      schema: FINDING_SCHEMA,
    }
  ),

  // Authentication specialist
  () => agent(
    `You are a VMware authentication expert. Analyze this migration log for auth failures:

    ${logData.log_content}

    Look for:
    - vCenter login failures
    - ESXi authentication errors
    - Permission denied errors
    - Invalid credentials
    - Token/session expiration
    - SSO issues
    - Insufficient privileges on VMs/datastores

    For each issue found, provide:
    - Exact error evidence
    - Which user/account has the issue
    - What permission is missing
    - Severity

    Reference the VMware ACL requirements from CLAUDE.md if relevant.`,
    {
      label: 'auth-expert',
      phase: 'Analyze',
      schema: FINDING_SCHEMA,
    }
  ),

  // Storage specialist
  () => agent(
    `You are a storage and disk expert. Analyze this migration log for storage issues:

    ${logData.log_content}

    Look for:
    - Disk format problems (thin/thick provisioning)
    - Snapshot creation/deletion failures
    - CBT (Change Block Tracking) errors
    - Datastore access issues
    - Out of space errors (source or destination)
    - Volume attachment failures in OpenStack
    - Cinder volume creation errors

    For each issue found, provide:
    - Exact error evidence
    - Which disk/volume has the problem
    - Root cause (capacity, format, permissions, etc.)
    - Severity`,
    {
      label: 'storage-expert',
      phase: 'Analyze',
      schema: FINDING_SCHEMA,
    }
  ),
]);

// Flatten and filter findings
const findings = allFindings
  .filter(Boolean)
  .flatMap(result => result.findings || [])
  .filter(f => f.severity === 'critical' || f.severity === 'warning');

if (findings.length === 0) {
  log('No significant issues found in log. Migration may have succeeded or log is incomplete.');
  return {
    summary: { vm_name: logData.vm_name, total_issues: 0 },
    message: 'No critical or warning issues detected. Check if migration actually failed or if log is truncated.',
  };
}

log(`Found ${findings.length} issues to research`);

// Phase 3: Research solutions for each finding
phase('Research');

const researchedFindings = await pipeline(
  findings,
  (finding, originalItem, index) => agent(
    `Research solutions for this migration issue:

    Issue: ${finding.title}
    Category: ${finding.category}
    Root Cause: ${finding.root_cause}
    Evidence: ${finding.evidence}

    Search for:
    1. Known solutions in VMware Migration Kit documentation
    2. Red Hat knowledge base articles
    3. GitHub issues in os-migrate/vmware-migration-kit
    4. Community forum discussions
    5. VMware/OpenStack documentation

    For each solution found:
    - Describe the fix in actionable terms
    - Provide exact commands if applicable
    - Estimate time to fix
    - Rate your confidence (high/medium/low)
    - Link to knowledge base articles

    Prioritize solutions that have worked for others.
    If you can't find a documented solution, suggest logical troubleshooting steps.`,
    {
      label: `research-${finding.category}-${index}`,
      phase: 'Research',
      schema: SOLUTION_SCHEMA,
    }
  )
);

// Phase 4: Synthesize final report
phase('Synthesize');

log('Synthesizing findings into actionable report...');

const report = await agent(
  `You are a migration troubleshooting expert. Create a comprehensive diagnostic report.

  You analyzed a migration log and found these issues with researched solutions:

  ${JSON.stringify(researchedFindings, null, 2)}

  VM Name: ${logData.vm_name || 'Unknown'}

  Create a prioritized report with:

  1. Summary:
     - VM name
     - Total issues found
     - Count by severity (critical, warning)

  2. Critical Issues (must fix):
     - Title (concise, actionable)
     - Category (virt-v2v, nbdkit, network, etc.)
     - Evidence (exact error from log)
     - Root cause (why it happened)
     - Solution (step-by-step fix)
     - Commands (exact commands to run, with proper escaping)

  3. Warnings (should fix):
     - Title
     - Impact (what happens if ignored)
     - Suggestions (how to improve)

  4. Knowledge Base Articles:
     - List all relevant KB articles, GitHub issues, docs

  5. Next Steps:
     - Ordered list of what to do (fix critical issues first)
     - Include estimated time for each step

  Prioritize by:
  - Severity (critical > warning)
  - Ease of fix (quick wins first among same severity)
  - Dependencies (fix auth before network, network before storage)

  Make solutions copy-pasteable and specific to this environment.
  Use the conversion host IP and SSH user from context: ${sshUser}@${conversionHost}`,
  {
    label: 'synthesize-report',
    phase: 'Synthesize',
    schema: REPORT_SCHEMA,
  }
);

log('Analysis complete!');

// Return the structured report for Claude to format nicely for the user
return {
  conversion_host: conversionHost,
  ssh_user: sshUser,
  log_path: logPath,
  log_metadata: {
    vm_name: logData.vm_name,
    size_bytes: logData.log_size_bytes,
    lines: logData.line_count,
  },
  report: report,
};
