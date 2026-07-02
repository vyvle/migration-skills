export const meta = {
  name: 'debug-osm-ci',
  description: 'Debug OpenStack migration environment: deploy fresh test instances, check connectivity, compare source vs destination, generate fixes',
  phases: [
    { title: 'Prelim', detail: 'Deploy fresh CentOS test instances on both clouds with generated SSH key' },
    { title: 'Checks', detail: 'Test internet, CentOS mirrors, DNS, OpenStack APIs, and cross-host connectivity' },
    { title: 'Compare', detail: 'Collect and compare OpenStack network config between source and destination' },
    { title: 'Solutions', detail: 'Generate concrete, copy-pasteable remediation commands' },
  ],
};

// ─── Schemas ──────────────────────────────────────────────────────────────────

const ACCESS_SCHEMA = {
  type: 'object',
  properties: {
    host_ip:          { type: 'string', description: 'Floating IP of the deployed test instance' },
    ssh_user:         { type: 'string', description: 'SSH user (always cloud-user for CentOS)' },
    instance_ssh_key: { type: 'string', description: 'Local path to the private key for connecting to the instance' },
    ssh_via_proxy:    { type: 'boolean', description: 'True if ProxyJump through devstack was needed' },
    accessible:       { type: 'boolean' },
    deployed_instance:{ type: 'boolean', description: 'True if a test instance was deployed' },
    instance_name:    { type: 'string' },
    openstack_network:{ type: 'string' },
    openstack_image:  { type: 'string' },
    error:            { type: 'string' },
  },
  required: ['accessible'],
};

const CHECKS_SCHEMA = {
  type: 'object',
  properties: {
    side:     { type: 'string' },
    host_ip:  { type: 'string' },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name:    { type: 'string' },
          target:  { type: 'string' },
          success: { type: 'boolean' },
          output:  { type: 'string', description: 'Truncated command output (max 200 chars)' },
        },
        required: ['name', 'target', 'success'],
      },
    },
    all_passed:   { type: 'boolean' },
    failed_checks:{ type: 'array', items: { type: 'string' } },
  },
  required: ['side', 'host_ip', 'checks', 'all_passed', 'failed_checks'],
};

const COMPARE_SCHEMA = {
  type: 'object',
  properties: {
    source_openstack: { type: 'string', description: 'Human-readable summary of source network config' },
    dest_openstack:   { type: 'string', description: 'Human-readable summary of destination network config' },
    differences: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          area:              { type: 'string', description: 'e.g. router external gateway, subnet DNS, security group' },
          source_value:      { type: 'string' },
          dest_value:        { type: 'string' },
          likely_root_cause: { type: 'string' },
          severity:          { type: 'string', enum: ['critical', 'warning', 'info'] },
        },
        required: ['area', 'likely_root_cause', 'severity'],
      },
    },
  },
  required: ['differences'],
};

const SOLUTION_SCHEMA = {
  type: 'object',
  properties: {
    fixes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          issue:          { type: 'string' },
          severity:       { type: 'string', enum: ['critical', 'warning', 'info'] },
          where_to_run:   { type: 'string', description: 'e.g. "destination devstack host" or "destination test instance"' },
          commands:       { type: 'array', items: { type: 'string' } },
          verify_command: { type: 'string', description: 'Command to confirm the fix worked' },
          explanation:    { type: 'string' },
        },
        required: ['issue', 'severity', 'where_to_run', 'commands'],
      },
    },
    summary:            { type: 'string' },
    verification_steps: { type: 'array', items: { type: 'string' } },
    quick_fix_runbook:  {
      type: 'array',
      description: 'Flat ordered list of exact shell commands to run to fix all issues, critical first. Use "# comment" lines to label each group. No explanations — just commands.',
      items: { type: 'string' },
    },
  },
  required: ['fixes', 'summary', 'quick_fix_runbook'],
};

// ─── Parse args and flags ─────────────────────────────────────────────────────
// Flags start with '--'; positional args are everything else.
// Example: /debug-osm-ci stack@<src-ip> stack@<dst-ip> --only=compare,solutions

const allArgs = (() => {
  if (Array.isArray(args)) return args;
  if (typeof args === 'string') {
    const t = args.trim();
    if (t.startsWith('[')) { try { return JSON.parse(t); } catch(e) {} }
    if (t) return t.split(/\s+/);
  }
  return [];
})();
const flagArgs       = allArgs.filter(a => typeof a === 'string' && a.startsWith('--'));
const positionalArgs = allArgs.filter(a => typeof a !== 'string' || !a.startsWith('--'));

const srcDevstack = positionalArgs[0] || '';
const dstDevstack = positionalArgs[1] || '';
const sshKey      = positionalArgs[2] || '~/.ssh/id_rsa';

if (!srcDevstack || !dstDevstack) {
  const missing = [!srcDevstack && 'SRC_IP', !dstDevstack && 'DST_IP'].filter(Boolean).join(', ');
  throw new Error(
    `Missing required connection parameters: ${missing}.\n` +
    `Set the environment variables before running:\n` +
    `  export SRC_IP=<source-devstack-ip>\n` +
    `  export DST_IP=<destination-devstack-ip>\n` +
    `Or pass them directly:\n` +
    `  /debug-osm-ci stack@<src-ip> stack@<dst-ip> [ssh-key]`
  );
}

const srcDevstackHost = srcDevstack.includes('@') ? srcDevstack.split('@')[1] : srcDevstack;
const dstDevstackHost = dstDevstack.includes('@') ? dstDevstack.split('@')[1] : dstDevstack;

// --only=<phase>[,<phase>...] — if absent, run all phases
const onlyFlag   = flagArgs.find(a => a.startsWith('--only='));
const onlyPhases = onlyFlag
  ? new Set(onlyFlag.replace('--only=', '').split(',').map(s => s.trim().toLowerCase()))
  : null;

const shouldRun = (p) => !onlyPhases || onlyPhases.has(p);

if (onlyPhases) {
  log(`Running only: ${Array.from(onlyPhases).join(', ')}`);
} else {
  log('Running all phases');
}
log(`Source devstack: ${srcDevstack}, Dest: ${dstDevstack}, Key: ${sshKey}`);

// ─── Mutable state shared across phases ──────────────────────────────────────

let srcAccess = null, dstAccess = null;
let srcHost   = '',   dstHost   = '';
let srcInstanceKey = '/tmp/debug-conv-test-key-source';
let dstInstanceKey = '/tmp/debug-conv-test-key-destination';
let srcOk = false, dstOk = false;

let srcChecks = null, dstChecks = null;
let srcPassed = true,  dstPassed = true;
let srcFailed = [],    dstFailed = [];

let comparison = null;
let solutions  = null;

// ─── Helper prompts ───────────────────────────────────────────────────────────

const accessCheckPrompt = (side, devstackSsh, localKeyPath) => `
You are deploying a fresh CentOS test instance on the ${side} OpenStack cloud to use as a debug target.
Use the Bash tool to run all commands. Source OpenRC with admin credentials for every OpenStack call.

Parameters:
  devstack SSH        : ${devstackSsh}
  SSH key for devstack: ${sshKey}
  Local key path      : ${localKeyPath}
  Instance name       : debug-conv-test-${side}
  Keypair name        : debug-conv-test-key

─── STEP 1: Generate SSH keypair on devstack ─────────────────────────────────
Run on the devstack host (overwrite if exists):
  ssh -i ${sshKey} -o StrictHostKeyChecking=no ${devstackSsh} \
    "ssh-keygen -t ed25519 -f /tmp/debug-conv-test-key -N '' -q -y 2>/dev/null; true; ssh-keygen -t ed25519 -f /tmp/debug-conv-test-key -N '' -q"

─── STEP 2: Upload public key to OpenStack (admin project) ───────────────────
Delete existing keypair if present, then create:
  ssh -i ${sshKey} -o StrictHostKeyChecking=no ${devstackSsh} \
    "source devstack/openrc admin admin && openstack keypair delete debug-conv-test-key 2>/dev/null; openstack keypair create --public-key /tmp/debug-conv-test-key.pub debug-conv-test-key"

─── STEP 3: Find CentOS image ────────────────────────────────────────────────
  ssh -i ${sshKey} -o StrictHostKeyChecking=no ${devstackSsh} \
    "source devstack/openrc admin admin && openstack image list --format json"
Select the first image whose name contains 'centos' (case-insensitive). If none, use the first image available.
Record IMAGE_ID.

─── STEP 4: Find medium-sized flavor ─────────────────────────────────────────
  ssh -i ${sshKey} -o StrictHostKeyChecking=no ${devstackSsh} \
    "source devstack/openrc admin admin && openstack flavor list --format json"
Prefer in order: m1.medium, m1.small, ds2G, any flavor with ≥2 GB RAM, then whatever is available.
Record FLAVOR_ID.

─── STEP 5: Find private (non-external) network ──────────────────────────────
  ssh -i ${sshKey} -o StrictHostKeyChecking=no ${devstackSsh} \
    "source devstack/openrc admin admin && openstack network list --format json"
Pick a non-external network. Prefer one named 'private'. Record PRIV_NET name.

─── STEP 6: Find public/external network ─────────────────────────────────────
  ssh -i ${sshKey} -o StrictHostKeyChecking=no ${devstackSsh} \
    "source devstack/openrc admin admin && openstack network list --external --format json"
Pick the first external network (usually 'public'). Record PUB_NET name.

─── STEP 7: Clean up any existing test instance (idempotent) ────────────────
Check whether the instance already exists:
  ssh -i ${sshKey} -o StrictHostKeyChecking=no ${devstackSsh} \
    "source devstack/openrc admin admin && openstack server show debug-conv-test-${side} -f value -c status 2>/dev/null || echo NOTFOUND"

If the instance exists (status is not "NOTFOUND"):
  a) Find its attached floating IP (may be empty if none):
     ssh -i ${sshKey} -o StrictHostKeyChecking=no ${devstackSsh} \
       "source devstack/openrc admin admin && openstack server show debug-conv-test-${side} -f json | \
        python3 -c \"import sys,json; d=json.load(sys.stdin); \
        [print(ip['addr']) for net in d.get('addresses',{}).values() \
         for ip in net if ip.get('OS-EXT-IPS:type')=='floating']\" 2>/dev/null"
  b) Delete the instance and wait:
     ssh -i ${sshKey} -o StrictHostKeyChecking=no ${devstackSsh} \
       "source devstack/openrc admin admin && openstack server delete debug-conv-test-${side} --wait 2>/dev/null; true"
  c) Release the old floating IP found in (a), if any:
     ssh -i ${sshKey} -o StrictHostKeyChecking=no ${devstackSsh} \
       "source devstack/openrc admin admin && openstack floating ip delete <OLD_FIP> 2>/dev/null; true"

─── STEP 8: Create the test instance ────────────────────────────────────────
Use the admin project, default security group:
  ssh -i ${sshKey} -o StrictHostKeyChecking=no ${devstackSsh} \
    "source devstack/openrc admin admin && openstack server create \
      --image <IMAGE_ID> \
      --flavor <FLAVOR_ID> \
      --network <PRIV_NET> \
      --key-name debug-conv-test-key \
      --security-group default \
      --wait \
      debug-conv-test-${side}"

─── STEP 9: Allocate floating IP and attach it ───────────────────────────────
  FIP=$(ssh -i ${sshKey} -o StrictHostKeyChecking=no ${devstackSsh} \
    "source devstack/openrc admin admin && openstack floating ip create <PUB_NET> -f value -c floating_ip_address")
  ssh -i ${sshKey} -o StrictHostKeyChecking=no ${devstackSsh} \
    "source devstack/openrc admin admin && openstack server add floating ip debug-conv-test-${side} $FIP"
Record the floating IP as HOST_IP.

─── STEP 10: Pull private key to local machine ───────────────────────────────
  ssh -i ${sshKey} -o StrictHostKeyChecking=no ${devstackSsh} "cat /tmp/debug-conv-test-key" > ${localKeyPath}
  chmod 600 ${localKeyPath}

─── STEP 11: Wait for SSH (up to 3 attempts × 30 s) ─────────────────────────
Use ProxyJump through devstack, specifying both keys:
  for i in 1 2 3; do
    sleep 30
    ssh -i ${localKeyPath} \
        -o "ProxyCommand=ssh -i ${sshKey} -o StrictHostKeyChecking=no -W %h:%p ${devstackSsh}" \
        -o StrictHostKeyChecking=no -o ConnectTimeout=15 \
        cloud-user@$HOST_IP "echo SSH_OK" && break
  done

Return:
  host_ip          = the floating IP
  ssh_user         = "cloud-user"
  instance_ssh_key = "${localKeyPath}"
  ssh_via_proxy    = true
  accessible       = true/false
  deployed_instance= true
  instance_name    = "debug-conv-test-${side}"
  openstack_image  = image name used
  openstack_network= private network name used
  error            = error message if failed, otherwise omit
`;

const checkPrompt = (side, convHost, devstackSsh, instanceKey, hostOk, otherConvHost) => {
  if (!hostOk || !convHost) {
    return `The ${side} test instance is not accessible (host="${convHost}"). Return exactly:
{"side":"${side}","host_ip":"${convHost || ''}","checks":[],"all_passed":false,"failed_checks":["SSH unreachable - skipping checks"]}`;
  }
  // Use ProxyCommand to specify separate keys for devstack hop and final instance
  const ssh = `ssh -i ${instanceKey} -o "ProxyCommand=ssh -i ${sshKey} -o StrictHostKeyChecking=no -W %h:%p ${devstackSsh}" -o StrictHostKeyChecking=no cloud-user@${convHost}`;
  const crossCheck = otherConvHost
    ? `7. Cross-host ping: ${ssh} "ping -c 3 -W 5 ${otherConvHost} 2>&1"
     success = "0% packet loss" in output`
    : `7. Cross-host ping: SKIP (other host IP unknown) — record success=true, output="skipped"`;
  return `
Run connectivity checks on the ${side} test instance. Use the Bash tool.
SSH pattern: ${ssh} "<command>"

Run each check as a SEPARATE SSH call. Truncate output to 200 chars.

1. Internet ICMP:   ${ssh} "ping -c 3 -W 5 8.8.8.8 2>&1"
   success = exit 0 AND "0% packet loss"

2. Internet HTTPS:  ${ssh} "curl -s --max-time 15 -o /dev/null -w '%{http_code}' https://www.google.com"
   success = "200"

3. CentOS mirror:   ${ssh} "curl -s --max-time 20 -o /dev/null -w '%{http_code}' http://mirror.centos.org/"
   success = "200", "301", or "302"

4. CentOS Stream:   ${ssh} "curl -s --max-time 20 -o /dev/null -w '%{http_code}' https://mirror.stream.centos.org/"
   success = "200", "301", or "302"

5. DNS resolution:  ${ssh} "nslookup mirror.centos.org 2>&1 | head -8"
   success = output contains an IP address (x.x.x.x)

6a. Src Keystone:   ${ssh} "curl -s --max-time 10 -o /dev/null -w '%{http_code}' http://${srcDevstackHost}:5000/"
    success = "200", "300", "301", or "401"

6b. Dst Keystone:   ${ssh} "curl -s --max-time 10 -o /dev/null -w '%{http_code}' http://${dstDevstackHost}:5000/"
    success = "200", "300", "301", or "401"

${crossCheck}

8. DNF/YUM repos:   ${ssh} "sudo dnf check-update --assumeno 2>&1 | grep -E '(Error|Cannot|Failed)' | head -5 || echo NO_ERRORS"
   success = "NO_ERRORS" or empty (dnf exit 100 with available updates is also OK)

Set all_passed=true ONLY if checks 1-8 all pass. List failed names in failed_checks.
`;
};

const comparePrompt = (srcFail, dstFail, convHostAvail) => `
You are comparing the OpenStack network configuration between source and destination devstack environments.
Use the Bash tool to collect data from both devstack hosts, then identify differences.

Source devstack      : ${srcDevstack}  (SSH key: ${sshKey})
Destination devstack : ${dstDevstack}
SSH command pattern  : ssh -i ${sshKey} -o StrictHostKeyChecking=no <devstack-host> "source devstack/openrc admin admin && <cmd>"

Source check failures      : ${JSON.stringify(srcFail)}
Destination check failures : ${JSON.stringify(dstFail)}

─── Collect on BOTH devstack hosts ───────────────────────────────────────────
1. openstack network list --format json
2. openstack subnet list --format json --long
3. openstack router list --format json
4. openstack router show <each-router-id> --format json
5. openstack security group rule list --format json --long (egress)
6. openstack security group rule list --format json --long (ingress)
7. openstack floating ip list --format json
8. openstack port list --format json

${convHostAvail ? `─── Collect on EACH accessible test instance (via ProxyJump) ────────────────
Source instance : cloud-user@${srcHost} via ${srcDevstack}  (reachable: ${srcOk})
  SSH: ssh -i ${srcInstanceKey} -o "ProxyCommand=ssh -i ${sshKey} -o StrictHostKeyChecking=no -W %h:%p ${srcDevstack}" -o StrictHostKeyChecking=no cloud-user@${srcHost} "<cmd>"

Dest instance   : cloud-user@${dstHost} via ${dstDevstack}  (reachable: ${dstOk})
  SSH: ssh -i ${dstInstanceKey} -o "ProxyCommand=ssh -i ${sshKey} -o StrictHostKeyChecking=no -W %h:%p ${dstDevstack}" -o StrictHostKeyChecking=no cloud-user@${dstHost} "<cmd>"

Collect from each:
  cat /etc/resolv.conf
  ip route show
  ip addr show
  sudo iptables -t nat -L POSTROUTING -n -v | head -20
  sudo iptables -L FORWARD -n -v | head -20` : `─── Note: test instances not available (prelim was skipped) ─────────────────
Focus on OpenStack API-level comparison only.`}

─── Identify differences that explain the failures ───────────────────────────
Look for:
  - Router missing external gateway → "no internet"
  - Subnet missing DNS nameservers → DNS resolution failures
  - Security group with no egress rules → ping/curl blocked
  - Missing NAT in iptables on devstack → outbound traffic dropped
  - Wrong or missing default route on instance → routing failures
  - Empty /etc/resolv.conf → DNS failures

Return:
  source_openstack : paragraph summarising source network config
  dest_openstack   : paragraph summarising destination network config
  differences      : list of differences with area, source_value, dest_value, likely_root_cause, severity
`;

const solutionsPrompt = (srcFail, dstFail, diff, srcConfig, dstConfig) => `
You are an OpenStack networking expert. Generate precise, copy-pasteable fix commands.

Environment:
  Source devstack      : ${srcDevstack}
  Destination devstack : ${dstDevstack}
  SSH key (devstack)   : ${sshKey}
  Source test instance : cloud-user@${srcHost || '(unknown)'} — key: ${srcInstanceKey}
  Dest test instance   : cloud-user@${dstHost || '(unknown)'} — key: ${dstInstanceKey}

SSH pattern for test instances (two-key ProxyCommand):
  ssh -i <instance-key> -o "ProxyCommand=ssh -i ${sshKey} -o StrictHostKeyChecking=no -W %h:%p <devstack>" -o StrictHostKeyChecking=no cloud-user@<fip> "<cmd>"

Failed checks:
  Source      : ${JSON.stringify(srcFail)}
  Destination : ${JSON.stringify(dstFail)}

Config differences:
${JSON.stringify(diff, null, 2)}

Source OpenStack config : ${srcConfig || 'not collected'}
Dest OpenStack config   : ${dstConfig || 'not collected'}

Generate fixes ordered by impact (most critical first):
  1. One-sentence description of the issue
  2. WHERE to run (e.g. "destination devstack host, after source devstack/openrc admin admin")
  3. Exact shell commands — use real IDs/names from the diff data above
  4. verify_command to confirm the fix worked

─── Reference fixes (use only what is relevant) ──────────────────────────────
Missing router external gateway:
  PUB=$(openstack network list --external -f value -c ID | head -1)
  openstack router set --external-gateway $PUB <router-id>
  Verify: openstack router show <router-id> | grep external_gateway_info

Missing subnet DNS:
  openstack subnet set --dns-nameserver 8.8.8.8 --dns-nameserver 8.8.4.4 <subnet-id>
  Verify: openstack subnet show <subnet-id> | grep dns_nameservers

No egress security group rules (fresh devstack):
  openstack security group rule create --protocol any --direction egress --ethertype IPv4 default
  openstack security group rule create --protocol any --direction egress --ethertype IPv6 default
  Verify: openstack security group rule list default --egress

Fix /etc/resolv.conf on destination instance:
  ssh -i ${dstInstanceKey} -o "ProxyCommand=ssh -i ${sshKey} -o StrictHostKeyChecking=no -W %h:%p ${dstDevstack}" -o StrictHostKeyChecking=no cloud-user@${dstHost || '<dst-fip>'} \
    "echo -e 'nameserver 8.8.8.8\\nnameserver 8.8.4.4' | sudo tee /etc/resolv.conf"

Fix missing default route on instance:
  GW=$(ssh -i ${sshKey} -o StrictHostKeyChecking=no ${dstDevstack} "source devstack/openrc admin admin && openstack subnet show <subnet-id> -f value -c gateway_ip")
  ssh -i ${dstInstanceKey} -o "ProxyCommand=ssh -i ${sshKey} -o StrictHostKeyChecking=no -W %h:%p ${dstDevstack}" -o StrictHostKeyChecking=no cloud-user@${dstHost || '<dst-fip>'} \
    "sudo ip route replace default via $GW"

Restart neutron L3 agent if NAT is broken:
  ssh -i ${sshKey} -o StrictHostKeyChecking=no ${dstDevstack} "sudo systemctl restart devstack@q-l3.service"

Cleanup test instances (run after debugging):
  ssh -i ${sshKey} -o StrictHostKeyChecking=no ${srcDevstack} \
    "source devstack/openrc admin admin && openstack server delete debug-conv-test-source --wait && openstack floating ip delete ${srcHost || '<src-fip>'} && openstack keypair delete debug-conv-test-key 2>/dev/null"
  ssh -i ${sshKey} -o StrictHostKeyChecking=no ${dstDevstack} \
    "source devstack/openrc admin admin && openstack server delete debug-conv-test-destination --wait && openstack floating ip delete ${dstHost || '<dst-fip>'} && openstack keypair delete debug-conv-test-key 2>/dev/null"

Provide summary and verification_steps (ordered list of commands to confirm environment is healthy after fixes).

─── quick_fix_runbook (REQUIRED) ─────────────────────────────────────────────
A flat, ordered array of exact shell commands to paste and run, one by one, to
fix ALL issues (critical first, then warnings). Rules:
  - Include "# Fix N (SEVERITY) — short label" comment lines before each group
  - Include "# Verify:" comment line followed by the verify command after each group
  - No prose, no markdown, no explanations — only valid shell lines and # comments
  - Use real IPs, keys, IDs from the data above (not placeholders)
  - Order: critical fixes first, then warnings, then final verification sweep
`;

// ─── PHASE: Prelim ────────────────────────────────────────────────────────────

if (shouldRun('prelim')) {
  phase('Prelim');
  log('Deploying fresh CentOS test instances on source and destination in parallel...');

  const prelimResults = await parallel([
    () => agent(accessCheckPrompt('source', srcDevstack, '/tmp/debug-conv-test-key-source'), {
      label: 'prelim-source', phase: 'Prelim', schema: ACCESS_SCHEMA,
    }),
    () => agent(accessCheckPrompt('destination', dstDevstack, '/tmp/debug-conv-test-key-destination'), {
      label: 'prelim-dest', phase: 'Prelim', schema: ACCESS_SCHEMA,
    }),
  ]);

  srcAccess = prelimResults[0];
  dstAccess = prelimResults[1];

  if (srcAccess && srcAccess.host_ip)          { srcHost = srcAccess.host_ip; srcOk = srcAccess.accessible; }
  if (srcAccess && srcAccess.instance_ssh_key)   srcInstanceKey = srcAccess.instance_ssh_key;
  if (dstAccess && dstAccess.host_ip)          { dstHost = dstAccess.host_ip; dstOk = dstAccess.accessible; }
  if (dstAccess && dstAccess.instance_ssh_key)   dstInstanceKey = dstAccess.instance_ssh_key;

  log(`Source instance : cloud-user@${srcHost || 'unknown'} (key: ${srcInstanceKey}) — ${srcOk ? 'reachable' : 'UNREACHABLE'}`);
  log(`Dest instance   : cloud-user@${dstHost || 'unknown'} (key: ${dstInstanceKey}) — ${dstOk ? 'reachable' : 'UNREACHABLE'}`);

  if (!srcOk && !dstOk) {
    const srcErr = (srcAccess && srcAccess.error) || 'deployment or SSH failed';
    const dstErr = (dstAccess && dstAccess.error) || 'deployment or SSH failed';
    log(`ERROR: Could not reach either test instance.`);
    log(`  Source (${srcDevstack}): ${srcErr}`);
    log(`  Destination (${dstDevstack}): ${dstErr}`);
    return {
      status: 'error',
      message: `Could not deploy/reach test instances.\n  Source: ${srcErr}\n  Destination: ${dstErr}\n\nCheck:\n  1. ssh -i ${sshKey} ${srcDevstack} "echo ok"\n  2. Verify devstack OpenRC: ssh -i ${sshKey} ${srcDevstack} "source devstack/openrc admin admin && openstack token issue"`,
      source_access: srcAccess,
      dest_access: dstAccess,
    };
  }
} else {
  log('Skipping Prelim (--only flag set). Instance IPs and keys are unknown — some phases may be limited.');
}

// ─── PHASE: Checks ────────────────────────────────────────────────────────────

if (shouldRun('checks')) {
  phase('Checks');
  log('Running connectivity checks on source and destination instances in parallel...');

  const checkResults = await parallel([
    () => agent(checkPrompt('source', srcHost, srcDevstack, srcInstanceKey, srcOk, dstHost), {
      label: 'checks-source', phase: 'Checks', schema: CHECKS_SCHEMA,
    }),
    () => agent(checkPrompt('destination', dstHost, dstDevstack, dstInstanceKey, dstOk, srcHost), {
      label: 'checks-dest', phase: 'Checks', schema: CHECKS_SCHEMA,
    }),
  ]);

  srcChecks = checkResults[0];
  dstChecks = checkResults[1];
  srcPassed = !!(srcChecks && srcChecks.all_passed);
  dstPassed = !!(dstChecks && dstChecks.all_passed);
  srcFailed = (srcChecks && srcChecks.failed_checks) || [];
  dstFailed = (dstChecks && dstChecks.failed_checks) || [];

  log(`Source      : ${srcPassed ? 'ALL PASSED' : 'FAILED: ' + srcFailed.join(', ')}`);
  log(`Destination : ${dstPassed ? 'ALL PASSED' : 'FAILED: ' + dstFailed.join(', ')}`);

  if (!onlyPhases && srcPassed && dstPassed) {
    log('All checks passed on both sides! Migration environment looks healthy.');
    return {
      status: 'healthy',
      source:      { access: srcAccess, checks: srcChecks },
      destination: { access: dstAccess, checks: dstChecks },
      message: 'All connectivity checks passed. Environment is ready for migration.',
    };
  }
} else {
  log('Skipping Checks (--only flag set).');
}

// ─── PHASE: Compare ───────────────────────────────────────────────────────────

if (shouldRun('compare')) {
  phase('Compare');
  const convHostAvail = srcOk || dstOk;
  const issuesSide = !srcPassed && !dstPassed ? 'both source and destination'
                   : !srcPassed               ? 'source'
                   : !dstPassed               ? 'destination'
                   :                            'both environments';
  log(`Gathering OpenStack config to compare ${issuesSide}...`);

  comparison = await agent(comparePrompt(srcFailed, dstFailed, convHostAvail), {
    label: 'compare-configs', phase: 'Compare', schema: COMPARE_SCHEMA,
  });

  const diffCount = (comparison && comparison.differences) ? comparison.differences.length : 0;
  log(`Found ${diffCount} configuration difference(s)`);
} else {
  log('Skipping Compare (--only flag set).');
}

// ─── PHASE: Solutions ─────────────────────────────────────────────────────────

if (shouldRun('solutions')) {
  phase('Solutions');
  log('Generating concrete remediation commands...');

  const diff      = (comparison && comparison.differences)      || [];
  const srcConfig = (comparison && comparison.source_openstack) || '';
  const dstConfig = (comparison && comparison.dest_openstack)   || '';

  solutions = await agent(solutionsPrompt(srcFailed, dstFailed, diff, srcConfig, dstConfig), {
    label: 'generate-solutions', phase: 'Solutions', schema: SOLUTION_SCHEMA,
  });

  if (solutions && solutions.quick_fix_runbook && solutions.quick_fix_runbook.length) {
    log('');
    log('═══ COMMANDS TO RUN ════════════════════════════════════════════════════════');
    for (const cmd of solutions.quick_fix_runbook) {
      log(cmd);
    }
    log('════════════════════════════════════════════════════════════════════════════');
  }
  log('Analysis complete!');
} else {
  log('Skipping Solutions (--only flag set).');
}

// ─── Return ───────────────────────────────────────────────────────────────────

return {
  status: srcPassed && dstPassed ? 'healthy'
        : srcPassed              ? 'destination_issues'
        : dstPassed              ? 'source_issues'
        :                          'both_issues',
  phases_run: onlyPhases ? Array.from(onlyPhases) : ['prelim', 'checks', 'compare', 'solutions'],
  source:      { access: srcAccess, checks: srcChecks },
  destination: { access: dstAccess, checks: dstChecks },
  comparison:  comparison,
  solutions:   solutions,
};
