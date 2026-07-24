#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=tests/testlib.sh
source "$root/tests/testlib.sh"

reviews="$root/bin/tuicr-reviews"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export TUICR_REVIEWS_FILE="$tmp/reg.jsonl"

repo="$tmp/repo"
mkdir -p "$repo"
git -C "$repo" init -q -b main
git -C "$repo" config user.name Test
git -C "$repo" config user.email test@example.com
printf 'base\n' > "$repo/file"
git -C "$repo" add file
git -C "$repo" commit -qm base
base_sha="$(git -C "$repo" rev-parse HEAD)"
git -C "$repo" switch -qc feature
printf 'feature\n' >> "$repo/file"
git -C "$repo" commit -qam feature
head_sha="$(git -C "$repo" rev-parse HEAD)"

manifest="$tmp/review.json"
jq -n \
  --arg repo "$repo" --arg base "$base_sha" --arg head "$head_sha" \
  '{
    schema:"agent-flow.local-review/v1", run_id:"review-one", flow:"feature",
    summary:"manifest review", created_at:"2026-07-15T11:00:00Z", repo:$repo, worktree:$repo,
    base:{branch:"main",sha:$base}, head:{branch:"feature",sha:$head},
    kanban:{board:"reviews",tenant:"review-one",task:"t_review"}, external_ref:null,
    artifacts:{review_summary:"/tmp/review.md",verification:"/tmp/verification.json",journal:"/tmp/journal.md",automated_findings:null,diagram:null},
    automated_review:{status:"passed",reviewed_head_sha:$head,findings_path:null,urgency:"standard",max_comments:20,per_tier_caps:{critical:20,important:20,recommended:20,nit:0}},
    review:{status:"review_ready",session_slug:null,reviewed_head_sha:null,consumed_comment_ids:[],generation:0,events:[],comment_dispositions:[],integration_receipts:[]}
  }' > "$manifest"

"$reviews" add --manifest "$manifest"
created="$(jq -r '.created' "$TUICR_REVIEWS_FILE")"
"$reviews" add --manifest "$manifest"
assert_status "$(wc -l < "$TUICR_REVIEWS_FILE" | tr -d ' ')" 1
[[ "$(jq -r '.created' "$TUICR_REVIEWS_FILE")" == "$created" ]] || fail "idempotent add changed creation time"
echo "ok - manifest add is idempotent"

before_rebuild="$($reviews list --json)"
"$reviews" rebuild --root "$tmp"
after_rebuild="$($reviews list --json)"
[[ "$before_rebuild" == "$after_rebuild" ]] || fail "live manifest rebuild changed projection"
echo "ok - live manifest projection rebuild is identical"

json="$($reviews list --json)"
assert_contains "$json" '"kind": "manifest"'
assert_contains "$json" '"lifecycle": "review_ready"'
assert_contains "$json" '"health": "current"'
assert_contains "$json" "\"base_sha\": \"$base_sha\""
assert_contains "$json" "\"head_sha\": \"$head_sha\""
echo "ok - JSON projection derives lifecycle, health, and immutable revisions from the manifest"

tsv="$($reviews list)"
[[ "$(printf '%s' "$tsv" | cut -f1)" == "$repo" ]] || fail "first TSV column changed"
[[ "$(printf '%s' "$tsv" | cut -f2)" == "main" ]] || fail "second TSV column changed"
[[ "$(printf '%s' "$tsv" | cut -f3)" == "feature" ]] || fail "third TSV column changed"
[[ "$(printf '%s' "$tsv" | cut -f9)" == "review_ready" ]] || fail "lifecycle column missing"
[[ "$(printf '%s' "$tsv" | cut -f10)" == "current" ]] || fail "health column missing"
echo "ok - list preserves the first seven TSV columns and appends lifecycle projection"

legacy="$tmp/legacy"
mkdir -p "$legacy"
legacy="$(cd "$legacy" && pwd -P)"
stale_tmp="$TUICR_REVIEWS_FILE.tmp.999999.stale"
printf 'stale\n' > "$stale_tmp"
"$reviews" add --repo owner/legacy --worktree "$legacy" --base main --branch legacy-feature --slug legacy --summary "legacy review"
[[ ! -e "$stale_tmp" ]] || fail "stale registry temp was not removed"
assert_contains "$(cat "$TUICR_REVIEWS_FILE")" '"kind":"legacy"'
assert_contains "$($reviews list --json)" '"run_id": null'
echo "ok - legacy add remains explicit and compatible"

"$reviews" toggle-approved --worktree "$legacy" --base main --branch legacy-feature
assert_contains "$($reviews list --approved --json)" '"kind": "legacy"'
evidence="$tmp/review-evidence.txt"
printf 'review evidence\n' > "$evidence"
tuicr_bin="$tmp/tuicr"
printf '%s\n' '#!/usr/bin/env bash' 'printf "[]\\n"' > "$tuicr_bin"
chmod +x "$tuicr_bin"
"$root/bin/agent-flow" review transition \
  --manifest "$manifest" --to reviewing --expected-generation 0 \
  --actor operator --reason "opened review" --evidence "$evidence" \
  --session-slug session-one >/dev/null
AGENT_FLOW_TUICR_BIN="$tuicr_bin" "$root/bin/agent-flow" review transition \
  --manifest "$manifest" --to approved --expected-generation 1 \
  --actor operator --reason "approved review" --evidence "$evidence" >/dev/null
assert_contains "$($reviews list --approved --json)" '"kind": "manifest"'
set +e
toggle_output="$($reviews toggle-approved --worktree "$repo" --base main --branch feature 2>&1)"
toggle_status=$?
set -e
assert_status "$toggle_status" 1
assert_contains "$toggle_output" 'approval toggles are legacy-only'
echo "ok - manifest approval comes only from the audited lifecycle"

rm -rf "$repo"
json="$($reviews list --json)"
assert_contains "$json" '"health": "missing_worktree"'
assert_contains "$(cat "$TUICR_REVIEWS_FILE")" '"manifest"'
echo "ok - vanished worktrees remain visible instead of silently pruning"

mkdir -p "$repo"
jq --arg head "$head_sha" '
  .review.status="archived"
  | .review.session_slug=null
  | .review.reviewed_head_sha=null
  | .review.generation=2
  | .review.integration_receipts=[{
      receipt_id:"receipt-one",
      path:"/tmp/integration-receipt.json",
      sha256:"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }]
  | .review.events=[
      {
        kind:"transition",generation:1,prior_generation:0,actor:"integrator",
        recorded_at:"2026-07-15T14:00:00Z",head_sha:$head,reason:"integrated",
        evidence:{path:"/tmp/integration-receipt.json",sha256:"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"},
        from:"review_ready",to:"integrated",comment_ids:[],
        integration_receipt:{receipt_id:"receipt-one",path:"/tmp/integration-receipt.json",sha256:"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}
      },
      {
        kind:"transition",generation:2,prior_generation:1,actor:"operator",
        recorded_at:"2026-07-15T14:01:00Z",head_sha:$head,reason:"archived",
        evidence:{path:"/tmp/integration-receipt.json",sha256:"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"},
        from:"integrated",to:"archived",comment_ids:[],integration_receipt:null
      }
    ]' "$manifest" > "$manifest.tmp"
mv "$manifest.tmp" "$manifest"
"$reviews" prune
assert_not_contains "$(cat "$TUICR_REVIEWS_FILE")" '"kind":"manifest"'
assert_contains "$(cat "$TUICR_REVIEWS_FILE")" '"kind":"legacy"'
echo "ok - prune removes terminal manifests while preserving legacy entries"

"$reviews" rebuild --root "$tmp"
first="$($reviews list --json)"
assert_not_contains "$first" '"kind": "manifest"'
"$reviews" rebuild --root "$tmp"
second="$($reviews list --json)"
[[ "$first" == "$second" ]] || fail "manifest rebuild projection changed"
echo "ok - registry rebuild from manifests is deterministic"

echo "ok - tuicr-reviews uses manifests as durable review truth"
