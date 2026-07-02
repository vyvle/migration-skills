---
name: debug-osm-ci
description: Debug os-migrate CI Environment
tags: [debug, ci, openstack, devstack, connectivity]
---

# Debug os-migrate CI Environment

Diagnose and fix connectivity issues in an OpenStack (devstack) migration environment.
Checks conversion host network reachability, compares source vs destination configs, and generates concrete OpenStack CLI fixes.

## Execution

When this skill is invoked:

**Step 1 — Resolve connection parameters.**
If `src_devstack` or `dst_devstack` are not given as arguments, read them from environment variables using the Bash tool:
```bash
echo "stack@${SRC_IP}"   # source devstack
echo "stack@${DST_IP}"   # destination devstack
```
If either env var is unset, abort with:
> "Set `SRC_IP` and `DST_IP` environment variables or pass them as positional arguments to `/debug-osm-ci`."

For the SSH key, use `$OSM_SSH_KEY` if set, otherwise `~/.ssh/id_rsa`.

**Step 2 — Run the workflow immediately:**
```
Workflow({ scriptPath: "~/.claude/skills/debug-osm-ci/workflow.js", args: [src_devstack, dst_devstack, ssh_key, ...remaining_args] })
```

After the workflow completes, present the results in a clear, structured format.

## Prerequisites

```bash
export SRC_IP=<source-devstack-ip>
export DST_IP=<destination-devstack-ip>
export OSM_SSH_KEY=~/.ssh/your_key   # optional, defaults to ~/.ssh/id_rsa
```

## Overview

The skill orchestrates four phases:

1. **Prelim** — Deploy a fresh CentOS test instance on each cloud (idempotent: removes any existing instance first, including its floating IP). Instances are reachable via ProxyJump through the devstack host.
2. **Checks** — Run connectivity probes in parallel on both test instances:
   - Internet ICMP (8.8.8.8)
   - Internet HTTPS (google.com)
   - CentOS mirrors (mirror.centos.org, mirror.stream.centos.org)
   - DNS resolution
   - OpenStack Keystone API reachability (source and destination)
   - Cross-host ping between instances
   - DNF/YUM repository access
3. **Compare** — Collect OpenStack network config from both devstacks (networks, subnets, routers, security groups, floating IPs) plus OS-level config (resolv.conf, ip route, iptables) from the test instances. Identify differences.
4. **Solutions** — Generate precise, copy-pasteable OpenStack CLI commands to fix each identified issue, ordered by impact. Ends with a `COMMANDS TO RUN` runbook.

## Usage

```bash
# Run all phases (reads SRC_IP / DST_IP from env)
/debug-osm-ci

# Explicit devstack hosts
/debug-osm-ci stack@<src-ip> stack@<dst-ip>

# Custom SSH key
/debug-osm-ci stack@<src-ip> stack@<dst-ip> ~/.ssh/my_key

# Skip discovery by providing known test instance IPs
/debug-osm-ci stack@<src-ip> stack@<dst-ip> ~/.ssh/my_key <src-fip> <dst-fip>

# ── Run only specific phases ──────────────────────────────────────────────────

# Just compare the two OpenStack environments (no SSH to test instances needed)
/debug-osm-ci --only=compare

# Compare + generate fixes
/debug-osm-ci --only=compare,solutions

# Only run connectivity checks (requires test instance IPs in args 4 & 5)
/debug-osm-ci stack@<src-ip> stack@<dst-ip> ~/.ssh/key <src-fip> <dst-fip> --only=checks

# Only deploy test instances
/debug-osm-ci --only=prelim

# --only flag can appear anywhere in the argument list
/debug-osm-ci stack@<src-ip> stack@<dst-ip> --only=compare,solutions
```

## Arguments

Positional arguments (flags starting with `--` are separated out automatically):

| Position | Argument | Default | Description |
|----------|----------|---------|-------------|
| 1 | `src_devstack` | `stack@$SRC_IP` | SSH connection to source devstack host |
| 2 | `dst_devstack` | `stack@$DST_IP` | SSH connection to destination devstack host |
| 3 | `ssh_key` | `$OSM_SSH_KEY` or `~/.ssh/id_rsa` | SSH key for devstack and test instances |
| 4 | `src_conv_host_ip` | (auto-discover) | Known floating IP of source test instance |
| 5 | `dst_conv_host_ip` | (auto-discover) | Known floating IP of destination test instance |

## Flags

| Flag | Values | Description |
|------|--------|-------------|
| `--only=<phase>` | `prelim`, `checks`, `compare`, `solutions` | Run only the listed phases (comma-separated). Omit to run all. |

### Phase dependencies when using `--only`

| Requested phase | What you need to provide |
|-----------------|--------------------------|
| `prelim` | Just devstack SSH + key |
| `checks` | Test instance IPs in args 4 & 5 (or run `prelim` first) |
| `compare` | Just devstack SSH + key (no test instance needed for OpenStack-level comparison) |
| `solutions` | Ideally combine with `compare`: `--only=compare,solutions` |

## Prerequisites

- SSH key must be valid for both devstack hosts
- Devstack OpenRC is assumed to be at `~/devstack/openrc` on each devstack host
- The admin project must have a CentOS/RHEL image in Glance (for instance deployment)
- If deploying a test instance: a `default` security group must exist

## How SSH Access Works

Test instance floating IPs are often only reachable via ProxyJump through the devstack host:

```bash
ssh -i $OSM_SSH_KEY -J stack@<src-ip> cloud-user@<floating-ip> "echo ok"
```

The skill tries ProxyJump first, then falls back to direct SSH.

## Connectivity Checks

| Check | Target | Expected |
|-------|--------|----------|
| Internet ICMP | 8.8.8.8 | 0% packet loss |
| Internet HTTPS | google.com | HTTP 200 |
| CentOS mirror | mirror.centos.org | HTTP 200/301 |
| CentOS Stream | mirror.stream.centos.org | HTTP 200/301 |
| DNS | mirror.centos.org | Resolves to IP |
| OpenStack source API | `src_devstack_ip/identity` | HTTP 200/401 |
| OpenStack dest API | `dst_devstack_ip/identity` | HTTP 200/401 |
| Cross-host ping | other test instance | 0% packet loss |
| DNF/YUM repos | package manager | No repo errors |

## Example Output

```
Phase: Prelim
  → Source test instance: cloud-user@172.24.4.5 (via proxy) — DEPLOYED
  → Dest test instance  : cloud-user@172.24.4.8 (via proxy) — DEPLOYED

Phase: Checks
  → Source: ALL PASSED
  → Destination: FAILED: Internet ICMP, CentOS mirror HTTP, DNS, DNF/YUM repos

Phase: Compare
  → Found 3 configuration differences:
    [CRITICAL] Host iptables MASQUERADE rule: source has active rule (68k packets), destination MISSING
    [CRITICAL] DNS cascade: direct consequence of missing NAT — no separate fix needed
    [WARNING]  Security group egress: source has IPv4/IPv6 any, destination has no egress rules

Phase: Solutions
  Fix 1 (CRITICAL) — Add missing MASQUERADE rule on destination devstack
    Commands:
      ssh -i $OSM_SSH_KEY stack@<dst-ip> "sudo iptables -t nat -A POSTROUTING -s <pub-cidr> -o <iface> -j MASQUERADE"
    Verify: sudo iptables -t nat -L POSTROUTING -v -n | grep MASQUERADE

═══ COMMANDS TO RUN ══════════════════════════════════════════════════════════
# Fix 1 (CRITICAL) — Add MASQUERADE rule on destination
ssh -i $OSM_SSH_KEY stack@<dst-ip> "sudo iptables -t nat -A POSTROUTING -s <pub-cidr> -o <iface> -j MASQUERADE"
# Verify:
ssh -i $OSM_SSH_KEY stack@<dst-ip> "sudo iptables -t nat -L POSTROUTING -v -n | grep MASQUERADE"
══════════════════════════════════════════════════════════════════════════════
```

## Common Issues and Fixes

**No internet from test instance**
- Host iptables missing MASQUERADE rule for the public subnet → `sudo iptables -t nat -A POSTROUTING -s <pub-cidr> -o <iface> -j MASQUERADE`
- Router missing external gateway → `openstack router set --external-gateway <pub-net-id> <router-id>`
- Security group blocking egress → add egress rules for IPv4/IPv6

**DNS resolution fails**
- Subnet has no DNS nameservers → `openstack subnet set --dns-nameserver 8.8.8.8 <subnet-id>`
- `/etc/resolv.conf` on instance is empty → write it directly via SSH
- Usually a cascade of the MASQUERADE issue — fix NAT first

**CentOS mirrors unreachable**
- Combination of DNS + routing issues — fix router gateway and DNS first
- If routing is fine, check `iptables -L FORWARD -n` on devstack for blocking rules

**Cross-host ping fails**
- Security group missing ICMP ingress rule → `openstack security group rule create --protocol icmp --direction ingress --remote-ip <remote-cidr> default`
- Test instances on different networks with no routing path

**DNF/YUM repos fail**
- Usually a consequence of DNS or routing failures — fix those first
- Or `/etc/yum.repos.d/` pointing to unavailable mirrors — check `dnf repolist`

**Neutron L3 agent broken (all routing fails)**
- `ssh stack@<devstack> "sudo systemctl restart devstack@q-l3.service"`

## Cleanup

If the skill deployed test instances, you can remove them afterward:

```bash
ssh -i $OSM_SSH_KEY stack@$SRC_IP \
  "source devstack/openrc admin admin && \
   openstack server delete debug-conv-test-source --wait && \
   openstack floating ip delete <src-fip>"

ssh -i $OSM_SSH_KEY stack@$DST_IP \
  "source devstack/openrc admin admin && \
   openstack server delete debug-conv-test-destination --wait && \
   openstack floating ip delete <dst-fip>"
```

## See Also

- `/diagnose-migration` — Analyze migration log failures (virt-v2v, nbdkit errors)
- `/vmw-build-prod` — Build the VMware Migration Kit collection
