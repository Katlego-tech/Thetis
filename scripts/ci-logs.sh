#!/usr/bin/env bash
# ci-logs.sh: keep GitHub Actions logs locally after GitHub's retention period.
#
#   bash scripts/ci-logs.sh            archive incomplete or new attempts for the newest 50 runs
#   bash scripts/ci-logs.sh <run-id>   archive (or refresh) the run's current attempt
#
# Each completed attempt goes to .ci-logs/<run-id>/attempt-<n>/ with run.json, full.log,
# artifacts/ (checks logs for the attempt, other available run artifacts, or a note), and a
# .complete marker. Failed downloads leave existing archives intact. In-progress runs and
# incomplete attempts can be retried.
set -euo pipefail

root="$(CDPATH='' cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
unset GH_REPO
out="$root/.ci-logs"
mkdir -p "$out"

archive() (
    local id="$1" attempt="$2" status="$3" run_dir="$out/$1"
    local dir="$run_dir/attempt-$attempt" stage="$run_dir/.attempt-$attempt.staging"

    if [ "$status" != completed ]; then
        echo "incomplete $id attempt $attempt: run is $status"
        return 0
    fi

    mkdir -p "$run_dir"
    if ! mkdir "$stage"; then
        echo "incomplete $id attempt $attempt: cannot create staging directory" >&2
        return 1
    fi
    cleanup() {
        if [ -d "$stage/previous" ] && [ ! -e "$dir" ]; then
            if ! mv "$stage/previous" "$dir"; then
                echo "previous archive is saved at $stage/previous" >&2
                return 1
            fi
        fi
        rm -rf "$stage"
    }
    trap cleanup EXIT
    trap 'exit 1' HUP INT TERM

    local next="$stage/archive" summary
    mkdir "$next"
    if ! gh run view "$id" --attempt "$attempt" \
        --json databaseId,attempt,name,displayTitle,event,headBranch,headSha,conclusion,createdAt,updatedAt,url,jobs \
        > "$next/run.json"; then
        echo "incomplete $id attempt $attempt: run metadata download failed"
        return 0
    fi
    if ! gh run view "$id" --attempt "$attempt" --log > "$next/full.log"; then
        echo "incomplete $id attempt $attempt: full log download failed"
        return 0
    fi
    if ! gh api "repos/{owner}/{repo}/actions/runs/$id/artifacts?per_page=100" --paginate |
        jq -j '.artifacts[] | select(.expired == false) | .name, "\u0000"' > "$stage/artifact-names"; then
        echo "incomplete $id attempt $attempt: artifact listing failed"
        return 0
    fi
    if [ -s "$stage/artifact-names" ]; then
        local artifact
        local -a artifact_args=()
        while IFS= read -r -d '' artifact; do
            if [ "$artifact" = "checks-logs-$id-$attempt" ]; then
                artifact_args=(--pattern "$artifact")
                break
            fi
            artifact_args+=(--name "$artifact")
        done < "$stage/artifact-names"
        if ! gh run download "$id" --dir "$next/artifacts" "${artifact_args[@]}" >/dev/null; then
            echo "incomplete $id attempt $attempt: artifact download failed"
            return 0
        fi
    else
        local note="$next/artifacts/NONE.txt"
        if [ -d "$dir/artifacts" ]; then
            cp -R "$dir/artifacts" "$next/artifacts"
            note="$next/artifacts-unavailable.txt"
        else
            mkdir "$next/artifacts"
        fi
        printf '%s\n' 'No artifacts were uploaded or they had expired.' > "$note"
    fi

    summary="$(jq -r '.name + " · " + .headBranch + " · " + (.conclusion // "?")' "$next/run.json")"
    touch "$next/.complete"
    # Keep the previous archive available for rollback until publication succeeds.
    if [ -d "$dir" ]; then
        mv "$dir" "$stage/previous"
    fi
    mv "$next" "$dir"
    echo "kept $id attempt $attempt: $summary -> ${dir#"$root"/}"
)

if [ $# -gt 0 ]; then
    if [[ ! "$1" =~ ^[0-9]+$ ]]; then
        echo "usage: bash scripts/ci-logs.sh [run-id]" >&2
        exit 1
    fi
    current="$(gh run view "$1" --json attempt,status --jq '[.attempt, .status] | @tsv')"
    IFS=$'\t' read -r attempt status <<< "$current"
    archive "$1" "$attempt" "$status"
    exit 0
fi
gh run list --limit 50 --json databaseId,attempt,status --jq '.[] | [.databaseId, .attempt, .status] | @tsv' |
    while IFS=$'\t' read -r id attempt status; do
        if [ ! -f "$out/$id/attempt-$attempt/.complete" ]; then
            archive "$id" "$attempt" "$status"
        fi
    done
