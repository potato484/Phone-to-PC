#!/usr/bin/env bash
set -euo pipefail

DEFAULT_REPO_URL="https://github.com/potato484/Phone-to-PC.git"

NON_INTERACTIVE=0
INSTALL_DIR="/opt/c2p"
SERVICE_USER="${SUDO_USER:-$USER}"
SKIP_TAILSCALE=0
REPO_URL="${C2P_REPO_URL:-$DEFAULT_REPO_URL}"

log() {
  printf '[install] %s\n' "$*"
}

warn() {
  printf '[install][warn] %s\n' "$*" >&2
}

die() {
  printf '[install][error] %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<USAGE
Usage: scripts/install.sh [options]

Options:
  --non-interactive         Run without prompts.
  --install-dir <path>      Install path (default: /opt/c2p).
  --service-user <user>     systemd runtime user (default: current user).
  --skip-tailscale          Skip Tailscale install/check.
  --repo-url <url>          Override git repository URL.
  -h, --help                Show this help.
USAGE
}

run_root() {
  if [[ $EUID -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

run_as_service_user() {
  local cmd="$1"
  if [[ $EUID -eq 0 ]]; then
    sudo -u "$SERVICE_USER" -H bash -lc "$cmd"
  else
    bash -lc "$cmd"
  fi
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --non-interactive)
        NON_INTERACTIVE=1
        shift
        ;;
      --install-dir)
        [[ $# -ge 2 ]] || die "missing value for --install-dir"
        INSTALL_DIR="$2"
        shift 2
        ;;
      --service-user)
        [[ $# -ge 2 ]] || die "missing value for --service-user"
        SERVICE_USER="$2"
        shift 2
        ;;
      --skip-tailscale)
        SKIP_TAILSCALE=1
        shift
        ;;
      --repo-url)
        [[ $# -ge 2 ]] || die "missing value for --repo-url"
        REPO_URL="$2"
        shift 2
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "unknown argument: $1"
        ;;
    esac
  done
}

detect_os_family() {
  local id_like=""
  local id=""
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    source /etc/os-release
    id_like="${ID_LIKE:-}"
    id="${ID:-}"
  fi

  local merged="${id_like} ${id}"
  if [[ "$merged" == *debian* || "$merged" == *ubuntu* ]]; then
    echo "debian"
    return
  fi
  if [[ "$merged" == *fedora* || "$merged" == *rhel* || "$merged" == *centos* ]]; then
    echo "fedora"
    return
  fi
  if [[ "$merged" == *arch* ]]; then
    echo "arch"
    return
  fi
  echo "unknown"
}

install_system_dependencies() {
  local missing=0
  local required_commands=(git curl tmux node python3 make gcc g++)
  for bin in "${required_commands[@]}"; do
    if ! command_exists "$bin"; then
      missing=1
      break
    fi
  done

  if [[ $missing -eq 0 ]]; then
    log "system dependencies already satisfied"
    return
  fi

  local os_family
  os_family="$(detect_os_family)"

  case "$os_family" in
    debian)
      log "installing dependencies via apt"
      run_root apt-get update
      run_root apt-get install -y git curl tmux python3 make gcc g++ build-essential ca-certificates nodejs npm
      ;;
    fedora)
      log "installing dependencies via dnf"
      run_root dnf install -y git curl tmux python3 make gcc gcc-c++ nodejs npm
      ;;
    arch)
      log "installing dependencies via pacman"
      run_root pacman -Sy --noconfirm git curl tmux python make gcc nodejs npm
      ;;
    *)
      warn "unsupported distro for auto-install, please install dependencies manually"
      ;;
  esac
}

ensure_pnpm() {
  if command_exists pnpm; then
    log "pnpm already installed"
    return
  fi

  if ! command_exists corepack; then
    die "corepack not found; please install pnpm manually"
  fi

  log "enabling pnpm via corepack"
  run_as_service_user "corepack enable && corepack prepare pnpm@9 --activate"
}

prepare_install_dir() {
  if [[ -d "$INSTALL_DIR" && ! -d "$INSTALL_DIR/.git" ]]; then
    die "install dir exists but is not a git repo: $INSTALL_DIR"
  fi

  run_root mkdir -p "$INSTALL_DIR"

  if [[ $EUID -eq 0 ]]; then
    if ! id "$SERVICE_USER" >/dev/null 2>&1; then
      die "service user not found: $SERVICE_USER"
    fi
    run_root chown -R "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_DIR"
  fi
}

sync_repository() {
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    log "updating existing repository"
    run_as_service_user "git -C '$INSTALL_DIR' fetch --all --tags && git -C '$INSTALL_DIR' pull --ff-only"
  else
    log "cloning repository to $INSTALL_DIR"
    run_as_service_user "git clone '$REPO_URL' '$INSTALL_DIR'"
  fi
}

ensure_env_file() {
  local env_file="$INSTALL_DIR/.env"
  local example_file="$INSTALL_DIR/.env.example"

  if [[ ! -f "$env_file" ]]; then
    if [[ -f "$example_file" ]]; then
      run_as_service_user "cp '$example_file' '$env_file'"
    else
      run_as_service_user "touch '$env_file'"
    fi
  fi

  local default_port="3000"
  local default_tunnel="tailscale"
  local default_funnel="false"

  if [[ $NON_INTERACTIVE -eq 0 ]]; then
    read -r -p "PORT [$default_port]: " input_port || true
    read -r -p "TUNNEL mode (tailscale/off) [$default_tunnel]: " input_tunnel || true
    read -r -p "TAILSCALE_FUNNEL (true/false) [$default_funnel]: " input_funnel || true
    [[ -n "${input_port:-}" ]] && default_port="$input_port"
    [[ -n "${input_tunnel:-}" ]] && default_tunnel="$input_tunnel"
    [[ -n "${input_funnel:-}" ]] && default_funnel="$input_funnel"
  fi

  upsert_missing_env "$env_file" "PORT" "$default_port"
  upsert_missing_env "$env_file" "TUNNEL" "$default_tunnel"
  upsert_missing_env "$env_file" "TAILSCALE_FUNNEL" "$default_funnel"
  upsert_missing_env "$env_file" "C2P_ACCESS_TOKEN_TTL_SECONDS" "86400"
}

upsert_missing_env() {
  local file="$1"
  local key="$2"
  local value="$3"

  if grep -Eq "^${key}=" "$file"; then
    return
  fi
  run_as_service_user "printf '%s=%s\n' '$key' '$value' >> '$file'"
}

install_node_dependencies() {
  local install_cmd="cd '$INSTALL_DIR' && pnpm install --frozen-lockfile || pnpm install"
  local build_cmd="cd '$INSTALL_DIR' && pnpm build"

  log "installing project dependencies"
  run_as_service_user "$install_cmd"
  log "building project"
  run_as_service_user "$build_cmd"
}

install_service_assets() {
  local service_src="$INSTALL_DIR/scripts/c2p.service"
  local ctl_src="$INSTALL_DIR/scripts/c2pctl"

  [[ -f "$service_src" ]] || die "missing service template: $service_src"
  [[ -f "$ctl_src" ]] || die "missing control script: $ctl_src"

  run_root install -m 0644 "$service_src" /etc/systemd/system/c2p@.service
  run_root install -m 0755 "$ctl_src" /usr/local/bin/c2pctl
  if command_exists systemctl; then
    run_root systemctl daemon-reload || warn "systemctl daemon-reload failed"
  fi
}

maybe_install_tailscale() {
  if [[ $SKIP_TAILSCALE -eq 1 ]]; then
    log "skip tailscale by flag"
    return
  fi

  if command_exists tailscale; then
    log "tailscale already installed"
    return
  fi

  if ! command_exists curl; then
    warn "curl missing; skip tailscale install"
    return
  fi

  log "installing tailscale (best effort)"
  if [[ $EUID -eq 0 ]]; then
    bash -lc "curl -fsSL https://tailscale.com/install.sh | sh" || warn "tailscale install failed"
  else
    sudo bash -lc "curl -fsSL https://tailscale.com/install.sh | sh" || warn "tailscale install failed"
  fi
}

print_summary() {
  local service_unit="c2p@${SERVICE_USER}.service"
  cat <<SUMMARY

Installation complete.

Install dir : ${INSTALL_DIR}
Service user: ${SERVICE_USER}
Service unit: ${service_unit}

Next steps:
1. (Optional) tailscale up
   sudo tailscale up
2. Enable and start service
   sudo systemctl enable --now ${service_unit}
3. Check status
   c2pctl status --user ${SERVICE_USER} --install-dir ${INSTALL_DIR}
4. View logs
   c2pctl logs --user ${SERVICE_USER}

Rollback:
1. Stop service
   sudo systemctl disable --now ${service_unit}
2. Remove install dir
   sudo rm -rf ${INSTALL_DIR}
3. Remove systemd unit and helper
   sudo rm -f /etc/systemd/system/c2p@.service /usr/local/bin/c2pctl
   sudo systemctl daemon-reload
SUMMARY
}

main() {
  parse_args "$@"

  log "target install dir: $INSTALL_DIR"
  log "service user: $SERVICE_USER"

  install_system_dependencies
  ensure_pnpm
  prepare_install_dir
  sync_repository
  ensure_env_file
  install_node_dependencies
  install_service_assets
  maybe_install_tailscale
  print_summary
}

main "$@"
