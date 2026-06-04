---
name: vmw-build-prod
description: Build production VMware Migration Kit collection on x86_64 architecture (local or remote)
version: 1.0
---

# VMware Migration Kit Production Build

Build the production Ansible collection for VMware Migration Kit. This skill ensures the build happens on an x86_64 architecture and verifies the resulting binaries are x86_64.

## How This Skill Works

When you invoke `/vmw-build-prod`, Claude Code:
1. Reads the `SKILL.md` file (this file) to understand what to do
2. Executes the bundled `scripts/build.sh` script with your provided arguments
3. The script handles all the build logic (architecture checks, git clone, make build-prod, etc.)
4. Returns the results back to you with formatted output

The skill is **self-contained** - all logic is in the bundled script, so it can be executed independently or via Claude Code.

## Arguments

The skill accepts these optional arguments (space-separated):
1. `<version>` - Git tag/branch to build (default: latest git tag)
2. `<build-machine-ip>` - IP address of remote build machine (default: local build)
3. `<ssh-user>` - SSH user for remote build (default: current user, only used for remote builds)

## Usage Examples

```bash
# Build latest version locally (must be on x86_64)
/vmw-build-prod

# Build specific version locally
/vmw-build-prod v2.2.4

# Build latest on remote machine
/vmw-build-prod latest 192.168.1.100

# Build specific version on remote machine with custom user
/vmw-build-prod v2.2.4 192.168.1.100 builder
```

## Manual Execution

You can also run the script directly without Claude Code:

```bash
# From the project root
./.claude/skills/vmw-build-prod/scripts/build.sh [version] [build-ip] [ssh-user]

# Examples
./.claude/skills/vmw-build-prod/scripts/build.sh v2.2.4
./.claude/skills/vmw-build-prod/scripts/build.sh latest 192.168.1.100 builder
```

## Build Process

Execute the bundled build script:

```bash
./scripts/build.sh "$@"
```

The script performs these steps:

1. **Parse Arguments**: Extract version, build machine IP, and SSH user from args
2. **Get Version**: If version is "latest" or empty, fetch the latest git tag
3. **Check Architecture**: Determine if current machine is x86_64 or needs remote build
4. **Local Build** (if x86_64):
   - Clone repository to `/tmp/vmware-migration-kit-build-<timestamp>`
   - Checkout the specified version
   - Run `make build-prod`
   - Verify binary architecture with `file` command
   - Copy tarball to `$HOME/Downloads/`
   - Clean up temp directory
5. **Remote Build** (if not x86_64 or IP provided):
   - SSH to remote machine and run build commands
   - Verify binary architecture remotely
   - SCP tarball to local `$HOME/Downloads/`
   - Clean up remote temp directory

## Expected Output

The skill should provide:
- ✅ Architecture check result (x86_64 or ARM/other)
- ✅ Build location (local or remote IP)
- ✅ Version being built
- ✅ Build progress and completion status
- ✅ Binary architecture verification
- ✅ Final tarball location
- ❌ Clear error messages if anything fails

## Example Summary

```
VMware Migration Kit Production Build:
✅ Architecture: x86_64 (local build)
✅ Version: v2.2.4
✅ Build: SUCCESS
✅ Binary verification: migrate is x86-64 ELF
✅ Output: ~/Downloads/os_migrate-vmware_migration_kit-2.2.4.tar.gz
```

Or for remote build:

```
VMware Migration Kit Production Build:
⚠️  Architecture: arm64 (remote build required)
✅ Remote host: 192.168.1.100 (user: builder)
✅ Version: v2.2.4
✅ Remote build: SUCCESS
✅ Binary verification: migrate is x86-64 ELF
✅ Downloaded: ~/Downloads/os_migrate-vmware_migration_kit-2.2.4.tar.gz
✅ Remote cleanup: SUCCESS
```
