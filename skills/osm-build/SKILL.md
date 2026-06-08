---
name: osm-build
description: Build and optionally publish os-migrate collection from GitHub release
tags: [build, publish, ansible, galaxy, os-migrate]
---

# OS-Migrate Build Skill

This skill automates building the os-migrate Ansible collection from a GitHub release tag and optionally publishing it to Ansible Galaxy.

## Usage

```
/osm-build [TAG] [--publish --api-key KEY]
```

**Arguments:**
- `TAG` (optional): Git tag/branch to build (e.g., `1.0.4`, `main`). If omitted, uses the latest tag.
- `--publish` (optional): Publish the built collection to Ansible Galaxy
- `--api-key KEY` (optional): Ansible Galaxy API key for publishing (required if --publish is used)

## Examples

```bash
# Build latest release
/osm-build

# Build specific version
/osm-build 1.0.4

# Build and publish to Galaxy
/osm-build 1.0.4 --publish --api-key abc123xyz

# Build from main branch
/osm-build main
```

## What it does

1. **Determine the tag to build**:
   - If TAG provided: use it
   - If not: fetch latest tag from GitHub repository
2. **Clone repository** in a temporary directory
3. **Checkout the specified tag/branch**
4. **Build collection** using `ansible-galaxy collection build`
5. **Verify build** succeeded and tar.gz exists
6. **Copy to Downloads** folder: `~/Downloads/os_migrate-os_migrate-X.Y.Z.tar.gz`
7. **Optionally publish** to Ansible Galaxy if `--publish` flag is provided

## Output

The built collection tarball is placed in: `~/Downloads/os_migrate-os_migrate-X.Y.Z.tar.gz`

---

# Implementation

You are responsible for:

1. **Parse arguments**:
   - Extract TAG (first positional argument)
   - Check for `--publish` flag
   - Extract `--api-key` value if present

2. **Determine the tag** to build:
   ```bash
   # If no TAG provided, get latest tag
   git ls-remote --tags --sort=v:refname https://github.com/os-migrate/os-migrate | tail -1 | awk '{print $2}' | sed 's|refs/tags/||'
   ```

3. **Create temporary directory** and clone:
   ```bash
   TMPDIR=$(mktemp -d)
   cd $TMPDIR
   git clone --depth 1 --branch TAG https://github.com/os-migrate/os-migrate
   cd os-migrate
   ```

4. **Build the collection**:
   ```bash
   # Ensure ansible-galaxy is available
   which ansible-galaxy || pip install ansible-core>=2.16.0
   
   # Build collection
   ansible-galaxy collection build
   ```

5. **Verify build succeeded**:
   ```bash
   # Check that tar.gz was created
   ls -la os_migrate-os_migrate-*.tar.gz
   
   # Get the filename
   TARBALL=$(ls os_migrate-os_migrate-*.tar.gz)
   ```

6. **Copy to Downloads**:
   ```bash
   cp $TARBALL $HOME/Downloads/
   echo "Collection built: $HOME/Downloads/$TARBALL"
   ```

7. **Optionally publish** (if `--publish` flag present):
   ```bash
   # Verify API key is provided
   if [ -z "$API_KEY" ]; then
     echo "Error: --api-key required when using --publish"
     exit 1
   fi
   
   # Publish to Galaxy
   ansible-galaxy collection publish $HOME/Downloads/$TARBALL --api-key $API_KEY
   ```

8. **Cleanup**:
   ```bash
   cd ~
   rm -rf $TMPDIR
   ```

9. **Show summary**:
   - Display the built collection path
   - Display version built
   - If published: show Galaxy URL

## Important Notes

- **Temporary directory**: Use `mktemp -d` to create a clean temporary workspace
- **Shallow clone**: Use `--depth 1` for faster cloning
- **Verify ansible-galaxy**: Check if ansible-galaxy command exists, install ansible-core if needed
- **Error handling**: 
  - If git clone fails: show error and exit
  - If build fails: show error, cleanup temp dir, and exit
  - If tar.gz not found: show error and exit
  - If publish fails: show error but keep the local tarball
- **API key security**: Never log or display the API key value
- **Tag validation**: If tag doesn't exist, show available tags

## Error Handling

- If TAG doesn't exist: List available tags and exit
- If ansible-galaxy not found and can't install: error and exit
- If build fails: Show build output and exit
- If --publish used without --api-key: error and exit
- If Galaxy publish fails: Show error but preserve local tarball

## Success Output Example

```
Building os-migrate collection from tag v1.0.4...
Cloning repository...
Building collection...
Created: os_migrate-os_migrate-1.0.4.tar.gz
Copied to: /Users/username/Downloads/os_migrate-os_migrate-1.0.4.tar.gz

Build successful!
- Version: 1.0.4
- Location: /Users/username/Downloads/os_migrate-os_migrate-1.0.4.tar.gz
- Size: 234 KB

Next steps:
  - Test: ansible-galaxy collection install ~/Downloads/os_migrate-os_migrate-1.0.4.tar.gz
  - Publish: /osm-build v1.0.4 --publish --api-key YOUR_KEY
```
