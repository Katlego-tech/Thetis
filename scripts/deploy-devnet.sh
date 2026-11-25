#!/usr/bin/env bash
# Builds programs/thetis and deploys (or upgrades) it on devnet. Devnet only.
#
#   bash scripts/deploy-devnet.sh
#
# Upgrade authority and fee payer: ${THETIS_KEYS_DIR:-$HOME/.config/thetis/devnet}/deployer.json
# The machine's default Solana config is mainnet-beta, so every solana and anchor call below passes
# the cluster explicitly and nothing ever reads that default.
set -euo pipefail

EXPECTED_PROGRAM_ID="jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3"
DEVNET_URL="devnet"
MARGIN_LAMPORTS=500000000 # 0.5 SOL

die() {
  printf 'deploy-devnet: %s\n' "$*" >&2
  exit 1
}

# Refuses any cluster or URL given as a flag or an environment variable unless it is devnet.
require_devnet() {
  local name value
  for name in CLUSTER URL SOLANA_URL SOLANA_CLUSTER ANCHOR_PROVIDER_URL; do
    value="${!name:-}"
    if [[ -n "$value" && "$value" != "devnet" && "$value" != "https://api.devnet.solana.com" ]]; then
      die "refusing: $name=$value is not devnet. This script only runs on devnet."
    fi
  done
  while (($# > 0)); do
    case "$1" in
      --url | -u | --cluster | --provider.cluster)
        [[ $# -ge 2 ]] || die "refusing: $1 needs a value, and only devnet is allowed."
        if [[ "$2" != "devnet" && "$2" != "https://api.devnet.solana.com" ]]; then
          die "refusing: $1 $2 is not devnet. This script only runs on devnet."
        fi
        shift 2
        ;;
      --url=* | -u=* | --cluster=* | --provider.cluster=*)
        value="${1#*=}"
        if [[ "$value" != "devnet" && "$value" != "https://api.devnet.solana.com" ]]; then
          die "refusing: ${1%%=*} $value is not devnet. This script only runs on devnet."
        fi
        shift
        ;;
      *)
        die "refusing: unknown argument $1. This script takes no arguments."
        ;;
    esac
  done
}

# check_program_id <keypair-pubkey> <lib.rs> <Anchor.toml>: all three must name the expected id.
check_program_id() {
  local keypair_pubkey="$1" lib_rs="$2" anchor_toml="$3" declared line found=0
  [[ "$keypair_pubkey" == "$EXPECTED_PROGRAM_ID" ]] \
    || die "target/deploy/thetis-keypair.json is $keypair_pubkey, expected $EXPECTED_PROGRAM_ID. Stopping."
  declared="$(sed -n 's/^[[:space:]]*declare_id!("\([^"]*\)").*/\1/p' "$lib_rs")"
  [[ "$declared" == "$EXPECTED_PROGRAM_ID" ]] \
    || die "declare_id! in $lib_rs is '${declared:-none}', expected $EXPECTED_PROGRAM_ID. Stopping."
  while IFS= read -r line; do
    found=1
    [[ "$line" == "$EXPECTED_PROGRAM_ID" ]] \
      || die "$anchor_toml names thetis as $line, expected $EXPECTED_PROGRAM_ID. Stopping."
  done < <(sed -n 's/^[[:space:]]*thetis[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$anchor_toml")
  [[ "$found" -eq 1 ]] || die "$anchor_toml has no thetis program entry. Stopping."
}

# check_keys_dir <dir> <repo-root>...: refuses a keys directory inside any repository root.
check_keys_dir() {
  local dir="$1" resolved root real_root
  shift
  resolved="$(resolve_path "$dir")"
  for root in "$@"; do
    real_root="$(resolve_path "$root")"
    if [[ "$resolved" == "$real_root" || "$resolved" == "$real_root"/* ]]; then
      die "refusing: THETIS_KEYS_DIR $resolved is inside the repository $real_root. Keep keys outside it."
    fi
  done
}

# Resolves symlinks through the nearest existing ancestor, so a directory not yet created is judged too.
resolve_path() {
  local path="$1" suffix="" parent
  [[ "$path" == /* ]] || path="$PWD/$path"
  while [[ ! -e "$path" ]]; do
    suffix="/$(basename "$path")$suffix"
    parent="$(dirname "$path")"
    [[ "$parent" != "$path" ]] || break
    path="$parent"
  done
  printf '%s%s\n' "$(cd "$path" && pwd -P)" "$suffix"
}

repository_roots() {
  local root common
  root="$(cd "$1" && pwd -P)"
  printf '%s\n' "$root"
  if common="$(git -C "$root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"; then
    dirname "$common"
  fi
}

lamports_of() {
  local value
  value="$(printf '%s\n' "$1" | grep -Eo '[0-9]+' | head -n 1 || true)"
  [[ -n "$value" ]] || die "could not read a lamport amount from: $1"
  printf '%s\n' "$value"
}

CFG_DIR=""

cleanup() {
  [[ -z "$CFG_DIR" ]] || rm -rf "$CFG_DIR"
}

# Every solana call goes through here: the dedicated devnet config AND an explicit --url, so the
# machine's own config (mainnet-beta) is never read.
sol() {
  solana "$@" --config "$CFG_DIR/config.yml" --url "$DEVNET_URL"
}

main() {
  require_devnet "$@"

  local script_dir repo keys_dir deployer program_keypair so_file
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  repo="$(dirname "$script_dir")"
  program_keypair="$repo/target/deploy/thetis-keypair.json"
  so_file="$repo/target/deploy/thetis.so"
  keys_dir="${THETIS_KEYS_DIR:-${HOME:?HOME is not set}/.config/thetis/devnet}"

  local -a roots=()
  mapfile -t roots < <(repository_roots "$repo")
  check_keys_dir "$keys_dir" "${roots[@]}"
  keys_dir="$(resolve_path "$keys_dir")"
  deployer="$keys_dir/deployer.json"

  [[ -f "$program_keypair" ]] || die "$program_keypair is missing. Run 'anchor build -p thetis' once, or restore the keypair."
  check_program_id "$(solana-keygen pubkey "$program_keypair")" \
    "$repo/programs/thetis/src/lib.rs" "$repo/Anchor.toml"

  if [[ ! -f "$deployer" ]]; then
    printf 'deploy-devnet: %s is missing. Create and fund the deployer, then run this again:\n' "$deployer" >&2
    printf '  mkdir -p "%s" && chmod 700 "%s"\n' "$keys_dir" "$keys_dir" >&2
    printf '  solana-keygen new --no-bip39-passphrase -o "%s"\n' "$deployer" >&2
    printf '  then fund that address from the devnet faucet (a fresh deploy needs about 9 SOL; repeat the request if one is not enough)\n' >&2
    exit 1
  fi
  local deployer_pubkey
  deployer_pubkey="$(solana-keygen pubkey "$deployer")"

  # A dedicated CLI config, so nothing is read from the machine's default one. Setting it is local.
  CFG_DIR="$(mktemp -d)"
  trap cleanup EXIT
  solana config set --config "$CFG_DIR/config.yml" \
    --url https://api.devnet.solana.com --ws wss://api.devnet.solana.com/ \
    --keypair "$deployer" >/dev/null

  (cd "$repo" && anchor build --provider.cluster "$DEVNET_URL" -p thetis)
  [[ -f "$so_file" ]] || die "build produced no $so_file"

  # Does the program already exist? A fresh deploy pays for two copies of the program (the upload
  # buffer and the program data). An upgrade pays for the buffer, plus rent for any growth of the
  # program data.
  local bytes show_out show_status=0 current_len=""
  bytes="$(wc -c <"$so_file" | tr -d ' ')"
  show_out="$(sol program show "$EXPECTED_PROGRAM_ID" 2>&1)" || show_status=$?
  if ((show_status == 0)); then
    current_len="$(printf '%s\n' "$show_out" | sed -n 's/^Data Length: *\([0-9][0-9]*\).*/\1/p' | head -n 1)"
    [[ -n "$current_len" ]] || die "could not read the program data length from: $show_out"
  elif ! printf '%s\n' "$show_out" | grep -Eqi 'unable to find the account|AccountNotFound|account does not exist'; then
    die "could not read $EXPECTED_PROGRAM_ID on devnet: $show_out"
  fi

  local rent_lamports needed growth=0 growth_rent=0 case_note balance
  rent_lamports="$(lamports_of "$(sol rent --lamports "$bytes")")"
  if [[ -z "$current_len" ]]; then
    needed=$((rent_lamports * 2 + MARGIN_LAMPORTS))
    case_note="fresh deploy: two copies of $bytes bytes + margin"
  else
    if ((bytes > current_len)); then
      growth=$((bytes - current_len))
      growth_rent="$(lamports_of "$(sol rent --lamports "$growth")")"
    fi
    needed=$((rent_lamports + growth_rent + MARGIN_LAMPORTS))
    case_note="upgrade: buffer of $bytes bytes + rent for $growth bytes of growth (program data is $current_len bytes) + margin"
  fi
  printf 'Funding case: %s. Minimum %s lamports.\n' "$case_note" "$needed"
  balance="$(lamports_of "$(sol balance --lamports --keypair "$deployer")")"
  if ((balance < needed)); then
    die "deployer $deployer_pubkey holds $balance lamports on devnet, needs $needed ($case_note). Short by $((needed - balance)) lamports. Fund it from the devnet faucet; one request may not be enough."
  fi

  # A fresh, private backup directory. It must not be inside the repository and must not exist yet.
  local stamp backup
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup="$keys_dir/backup/$stamp"
  check_keys_dir "$backup" "${roots[@]}"
  (umask 077 && mkdir -p "$keys_dir/backup")
  [[ ! -e "$backup" ]] || die "backup directory $backup already exists. Wait a second and run again."
  mkdir -m 700 "$backup"
  cp "$deployer" "$backup/deployer.json"
  cp "$program_keypair" "$backup/thetis-keypair.json"
  chmod 600 "$backup/deployer.json" "$backup/thetis-keypair.json"
  printf 'Keypairs backed up to %s\n' "$backup"

  if ((growth > 0)); then
    sol program extend "$EXPECTED_PROGRAM_ID" "$growth" --keypair "$deployer"
  fi

  sol program deploy "$so_file" \
    --program-id "$program_keypair" \
    --upgrade-authority "$deployer" \
    --keypair "$deployer"

  sol program show "$EXPECTED_PROGRAM_ID"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
