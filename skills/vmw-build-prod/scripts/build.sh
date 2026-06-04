#!/bin/bash
set -euo pipefail

# VMware Migration Kit Production Build Script
# Ensures builds happen on x86_64 architecture

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Repository configuration
REPO_URL="https://github.com/os-migrate/vmware-migration-kit.git"

# Parse arguments
VERSION="${1:-latest}"
BUILD_IP="${2:-}"
SSH_USER="${3:-${USER}}"

# Get current architecture
CURRENT_ARCH=$(uname -m)

# Function to print colored output
print_status() {
    local color=$1
    shift
    echo -e "${color}$*${NC}"
}

print_success() {
    print_status "$GREEN" "✅ $*"
}

print_error() {
    print_status "$RED" "❌ $*"
}

print_warning() {
    print_status "$YELLOW" "⚠️  $*"
}

print_info() {
    print_status "$BLUE" "ℹ️  $*"
}

# Function to get latest git tag
get_latest_tag() {
    local repo_url=$1
    git ls-remote --tags --refs "$repo_url" | \
        grep -v '\^{}' | \
        awk '{print $2}' | \
        sed 's#refs/tags/##' | \
        sort -V | \
        tail -1
}

# Function to verify binary architecture
verify_binary_arch() {
    local binary_path=$1
    local file_output

    if [[ ! -f "$binary_path" ]]; then
        print_error "Binary not found: $binary_path"
        return 1
    fi

    file_output=$(file "$binary_path")

    if echo "$file_output" | grep -q "x86-64\|x86_64"; then
        print_success "Binary verification: x86-64 ELF"
        return 0
    else
        print_error "Binary verification FAILED: $file_output"
        return 1
    fi
}

# Function to build locally
build_local() {
    local version=$1
    local timestamp
    timestamp=$(date +%Y%m%d_%H%M%S)
    local build_dir="/tmp/vmware-migration-kit-build-${timestamp}"

    print_info "Building locally on x86_64 architecture"
    print_info "Version: $version"
    print_info "Build directory: $build_dir"

    # Clone repository
    print_info "Cloning repository..."
    if ! git clone "$REPO_URL" "$build_dir"; then
        print_error "Failed to clone repository"
        return 1
    fi

    cd "$build_dir"

    # Checkout version
    print_info "Checking out version: $version"
    if ! git checkout "$version"; then
        print_error "Failed to checkout version: $version"
        cd - > /dev/null
        rm -rf "$build_dir"
        return 1
    fi

    # Extract version from galaxy.yml
    local collection_version
    collection_version=$(grep -E "^version:" galaxy.yml | sed 's/version: *//g')
    print_info "Collection version: $collection_version"

    # Build production tarball
    print_info "Running make build-prod..."
    if ! make build-prod; then
        print_error "Build failed"
        cd - > /dev/null
        rm -rf "$build_dir"
        return 1
    fi

    # Verify binary architecture
    print_info "Verifying binary architecture..."
    if ! verify_binary_arch "$build_dir/plugins/modules/migrate"; then
        cd - > /dev/null
        rm -rf "$build_dir"
        return 1
    fi

    # Find and copy tarball
    local tarball
    tarball=$(find "$build_dir" -maxdepth 1 -name "os_migrate-vmware_migration_kit-*.tar.gz" | head -1)

    if [[ -z "$tarball" ]]; then
        print_error "Tarball not found"
        cd - > /dev/null
        rm -rf "$build_dir"
        return 1
    fi

    local tarball_name
    tarball_name=$(basename "$tarball")
    local dest="$HOME/Downloads/$tarball_name"

    print_info "Copying tarball to $dest"
    if ! cp "$tarball" "$dest"; then
        print_error "Failed to copy tarball"
        cd - > /dev/null
        rm -rf "$build_dir"
        return 1
    fi

    # Cleanup
    cd - > /dev/null
    print_info "Cleaning up build directory..."
    rm -rf "$build_dir"

    print_success "Build complete!"
    print_success "Output: $dest"
    return 0
}

# Function to build remotely
build_remote() {
    local version=$1
    local remote_ip=$2
    local remote_user=$3
    local timestamp
    timestamp=$(date +%Y%m%d_%H%M%S)
    local remote_build_dir="/tmp/vmware-migration-kit-build-${timestamp}"
    local remote_ssh="${remote_user}@${remote_ip}"

    print_info "Building remotely on $remote_ssh"
    print_info "Version: $version"

    # Check SSH connectivity
    print_info "Testing SSH connection..."
    if ! ssh -o ConnectTimeout=5 -o BatchMode=yes "$remote_ssh" "echo 'SSH OK'" > /dev/null 2>&1; then
        print_error "SSH connection failed to $remote_ssh"
        print_error "Ensure SSH key authentication is set up"
        return 1
    fi

    # Check remote architecture
    print_info "Checking remote architecture..."
    local remote_arch
    remote_arch=$(ssh "$remote_ssh" "uname -m")

    if [[ "$remote_arch" != "x86_64" ]]; then
        print_error "Remote machine is $remote_arch, not x86_64!"
        return 1
    fi
    print_success "Remote architecture: x86_64"

    # Create remote build directory
    print_info "Creating remote build directory..."
    ssh "$remote_ssh" "mkdir -p $remote_build_dir"

    # Clone repository on remote
    print_info "Cloning repository on remote..."
    ssh "$remote_ssh" "cd $remote_build_dir && git clone $REPO_URL ."

    # Checkout version
    print_info "Checking out version: $version"
    ssh "$remote_ssh" "cd $remote_build_dir && git checkout $version"

    # Extract version from galaxy.yml
    local collection_version
    collection_version=$(ssh "$remote_ssh" "grep -E '^version:' $remote_build_dir/galaxy.yml | sed 's/version: *//g'")
    print_info "Collection version: $collection_version"

    # Build on remote
    print_info "Running make build-prod on remote..."
    if ! ssh "$remote_ssh" "set +u; cd $remote_build_dir && make build-prod 2>&1"; then
        print_error "Remote build failed"
        ssh "$remote_ssh" "rm -rf $remote_build_dir"
        return 1
    fi

    # Verify binary architecture on remote
    print_info "Verifying binary architecture on remote..."
    local file_output
    file_output=$(ssh "$remote_ssh" "file $remote_build_dir/plugins/modules/migrate")

    if echo "$file_output" | grep -q "x86-64\|x86_64"; then
        print_success "Binary verification: x86-64 ELF"
    else
        print_error "Binary verification FAILED: $file_output"
        ssh "$remote_ssh" "rm -rf $remote_build_dir"
        return 1
    fi

    # Find tarball on remote
    local remote_tarball
    remote_tarball=$(ssh "$remote_ssh" "find $remote_build_dir -maxdepth 1 -name 'os_migrate-vmware_migration_kit-*.tar.gz' | head -1")

    if [[ -z "$remote_tarball" ]]; then
        print_error "Tarball not found on remote"
        ssh "$remote_ssh" "rm -rf $remote_build_dir"
        return 1
    fi

    local tarball_name
    tarball_name=$(basename "$remote_tarball")
    local local_dest="$HOME/Downloads/$tarball_name"

    # Download tarball
    print_info "Downloading tarball to $local_dest"
    if ! scp "$remote_ssh:$remote_tarball" "$local_dest"; then
        print_error "Failed to download tarball"
        ssh "$remote_ssh" "rm -rf $remote_build_dir"
        return 1
    fi

    # Cleanup remote
    print_info "Cleaning up remote build directory..."
    ssh "$remote_ssh" "rm -rf $remote_build_dir"

    print_success "Remote build complete!"
    print_success "Downloaded: $local_dest"
    return 0
}

# Main execution
main() {
    echo ""
    print_info "VMware Migration Kit Production Build"
    print_info "======================================"
    echo ""

    # Resolve version if "latest"
    if [[ "$VERSION" == "latest" ]] || [[ -z "$VERSION" ]]; then
        print_info "Fetching latest git tag..."
        VERSION=$(get_latest_tag "$REPO_URL")
        if [[ -z "$VERSION" ]]; then
            print_error "Failed to fetch latest tag"
            exit 1
        fi
        print_info "Latest version: $VERSION"
    fi

    # Display architecture
    print_info "Current architecture: $CURRENT_ARCH"

    # Determine build location
    if [[ -n "$BUILD_IP" ]]; then
        # User explicitly specified remote build
        print_info "Remote build requested: $BUILD_IP"
        build_remote "$VERSION" "$BUILD_IP" "$SSH_USER"
    elif [[ "$CURRENT_ARCH" == "x86_64" ]]; then
        # Local x86_64 build
        print_success "Architecture is x86_64, building locally"
        build_local "$VERSION"
    else
        # Not x86_64, need remote IP
        print_warning "Architecture is $CURRENT_ARCH (not x86_64)"
        print_error "Remote build machine IP required"
        print_error "Usage: /vmw-build-prod [version] [build-ip] [ssh-user]"
        print_error "Example: /vmw-build-prod v2.2.4 192.168.1.100 builder"
        exit 1
    fi

    echo ""
    print_success "Build process completed successfully!"
}

# Run main function
main
