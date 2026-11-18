#!/usr/bin/env bash
# ci-logs.sh: keep GitHub Actions logs on this machine, past GitHub's 90-day retention.
#
#   bash scripts/ci-logs.sh            archive every run not archived yet (newest 50)
#   bash scripts/ci-logs.sh <run-id>   archive (or refresh) one run
#
# Each run goes to .ci-logs/<run-id>/ (git-ignored): run.json (what ran, on which commit, with
# what result), full.log (every job's log) and artifacts/ (the run's uploaded logs). A run still
# in progress is skipped, so its partial log is never stored as if it were final.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$root/.ci-logs"
mkdir -p "$out"

archive() {
    local id="$1" dir="$out/$1" status
    status="$(gh run view "$id" --json status --jq .status)"
    if [ "$status" != completed ]; then echo "skip $id: $status"; return 0; fi
    mkdir -p "$dir"
    gh run view "$id" --json databaseId,name,displayTitle,event,headBranch,headSha,conclusion,createdAt,updatedAt,url,jobs \
        > "$dir/run.json"
    gh run view "$id" --log > "$dir/full.log" 2>&1 || echo "(log unavailable: expired or still processing)" > "$dir/full.log"
    rm -rf "$dir/artifacts"
    gh run download "$id" --dir "$dir/artifacts" >/dev/null 2>&1 || true
    echo "kept $id: $(jq -r '.name + " · " + .headBranch + " · " + (.conclusion // "?")' "$dir/run.json") -> ${dir#"$root"/}"
}

if [ $# -gt 0 ]; then
    archive "$1"
    exit 0
fi
gh run list --limit 50 --json databaseId --jq '.[].databaseId' | while read -r id; do
    [ -f "$out/$id/run.json" ] || archive "$id"
done
