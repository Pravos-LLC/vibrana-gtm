#!/usr/bin/env bash
# The note dispatcher: acts on John's review notes without anyone opening a chat (John, 2026-10-17: "do I need to come
# back to a chat window here in Claude Code and ask someone to make edits after I give comments?").
#
# Installed as a LaunchAgent by ops/install-work-dispatch.sh, it runs every 3 minutes. Each run:
#   1. stops if a dispatched run is still going (lock), or Claude Code is not signed in with the claude.ai subscription;
#   2. asks `gtm work next --mark` for the oldest piece with John's notes no job covers (none: exit). That call also
#      blocks dispatcher jobs left running by a dead run and notes tried three times, so /work says why;
#   3. starts ONE headless `claude -p` in the hub on that piece, in its own process group, with a tool allowlist, a
#      denylist for anything that publishes, schedules, releases, sends or pushes, and a 45-minute limit. The run claims
#      the piece with `gtm work add` first, so /work shows it In progress, then fixes, stages and resolves;
#   4. when the run exits non-zero or is stopped at the limit, marks its open job blocked with the reason.
# ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN are removed from the run's environment: with either set, Claude Code bills
# the API instead of John's subscription (the Tessera root .env exports ANTHROPIC_API_KEY).
# Log: ~/Library/Logs/vibrana/work-dispatch.log. Attempts: ~/Library/Logs/vibrana/work-dispatch-state.json (a run that
# never claims its piece is retried after 30 minutes, three times at most for the same notes).
# WORK_DISPATCH_DRY=1 does everything up to the start, records nothing, and logs what it would run.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # this vibrana-gtm checkout
# shellcheck source=ops/work-dispatch-lib.sh
. "$DIR/ops/work-dispatch-lib.sh"
LOGDIR="$HOME/Library/Logs/vibrana"
LOG="$LOGDIR/work-dispatch.log"
STATE="$LOGDIR/work-dispatch-state.json"
CLAUDE_BIN="${CLAUDE_BIN:-$HOME/.local/bin/claude}"
LIMIT_SECONDS="${WORK_DISPATCH_LIMIT:-2700}"
GRACE_SECONDS="${WORK_DISPATCH_GRACE:-20}"
mkdir -p "$LOGDIR"
exec >>"$LOG" 2>&1
# Keep the log bounded; truncate in place (launchd holds it open).
if [ "$(wc -l <"$LOG")" -gt 5000 ]; then tail -n 5000 "$LOG" >"$LOG.tmp" && cat "$LOG.tmp" >"$LOG" && rm -f "$LOG.tmp"; fi
say() { echo "$(date -u +%FT%TZ) $*"; }
# The hub that holds this checkout (vibrana.json), not just its parent: from a worktree the parent is
# <hub>/vibrana-gtm-worktrees, where the env loader is missing and the hub's hooks would not apply to the run.
HUB="$(dispatch_hub "$DIR")" || { say "not under the Vibrana hub (no vibrana.json above $DIR); nothing started"; exit 1; }

export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use --silent default >/dev/null
export PATH="$DIR/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH:/usr/bin:/bin:/usr/sbin:/sbin"

# One run at a time. The lock is a symlink whose target names its owner, "pid|start time": `ln -s` creates it with
# that content in one step or fails if it exists, so there is no moment where a lock has no owner. The start time
# means a pid reused after a reboot does not hold the lock.
LOCK="$LOGDIR/work-dispatch.lock"
started() { ps -o lstart= -p "$1" 2>/dev/null | tr -s ' '; }
ME="$$|$(started $$)"
# A lock directory from the first version of this script would make `ln -s` link inside it.
[ -d "$LOCK" ] && [ ! -L "$LOCK" ] && rm -rf "$LOCK"
held() { local v pid; v="$(readlink "$LOCK" 2>/dev/null)" || return 1; pid="${v%%|*}"; [ -n "$(started "$pid")" ] && [ "$v" = "$pid|$(started "$pid")" ]; }
if ! ln -s "$ME" "$LOCK" 2>/dev/null; then
  held && exit 0
  # Stale: its owner is gone. Remove it only if it is still that same stale lock, then try once more.
  stale="$(readlink "$LOCK" 2>/dev/null)"
  [ "$(readlink "$LOCK" 2>/dev/null)" = "$stale" ] && rm -f "$LOCK"
  ln -s "$ME" "$LOCK" 2>/dev/null || exit 0
fi
trap '[ "$(readlink "$LOCK" 2>/dev/null)" = "$ME" ] && rm -f "$LOCK"' EXIT

# Env the way the hub loader does it (direnv does not run under launchd): hub, then this repo, then personal values.
# Every file goes through the same parser, which never expands or executes a value.
load() { [ -f "$1" ] && eval "$(cd "$(dirname "$1")" && node "$HUB/scripts/env-to-shell.mjs" "$(basename "$1")" ${2:+"$2"} 2>/dev/null)"; }
[ -f "$HUB/.env.keys" ] && load "$HUB/.env.team" .env.keys
[ -f "$DIR/.env.keys" ] && load "$DIR/.env.team" .env.keys
load "$HUB/.env.local"; load "$DIR/.env.local"

# Subscription only: never fall through to an API key.
AUTH="$(env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN "$CLAUDE_BIN" auth status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.loggedIn&&j.authMethod==="claude.ai"?`ok ${j.subscriptionType??""}`:`no ${j.authMethod??"none"}`)}catch{process.stdout.write("no unreadable")}})')"
case "$AUTH" in ok*) ;; *) say "skip: Claude Code is not signed in with the claude.ai subscription ($AUTH); run: claude auth login"; exit 1 ;; esac

# One call picks the piece and (outside a dry run) records the attempt, so the piece logged is the piece prompted.
if [ -n "${WORK_DISPATCH_DRY:-}" ]; then PICK="$(gtm work next --state "$STATE" --json 2>&1)"; else PICK="$(gtm work next --state "$STATE" --mark --json 2>&1)"; fi || { say "gtm work next failed: $PICK"; exit 1; }
[ "$PICK" = "null" ] && exit 0
field() { node -e 'const p=JSON.parse(process.argv[1]); process.stdout.write(String(p[process.argv[2]] ?? ""))' "$PICK" "$1"; }
PIECE="$(field piece)"
PROMPT="$(field prompt)"
[ -n "$PIECE" ] && [ -n "$PROMPT" ] || { say "gtm work next returned no piece: $PICK"; exit 1; }
if [ -n "${WORK_DISPATCH_DRY:-}" ]; then say "dry run: would start $PIECE ($(field source)) (${AUTH#ok })"; exit 0; fi

say "start $PIECE (${AUTH#ok }) limit ${LIMIT_SECONDS}s"
cd "$HUB" || exit 1
# Allowed: file tools, skills, and the CLIs the content pipeline needs. Denied (deny wins over allow): every command
# that schedules, publishes, releases a hold, sends a link, a reply or an email, or pushes or merges code. Approval and
# release are John's; the prompt says the same as a second layer.
DENY=()
while IFS= read -r d; do DENY+=("$d"); done < <(dispatch_deny)
# The run gets its own process group and the limit (dispatch_run, ops/work-dispatch-lib.sh): at the limit every process
# under it is recorded (Claude Code's Bash tool shells are detached, so the run's group alone misses their ffmpeg or
# pnpm), sent TERM, given WORK_DISPATCH_GRACE seconds (20), then KILL. The watcher does all of it, so a run that
# ignores TERM is still stopped, and the lock is held until it has.
TIMED_OUT="$LOGDIR/work-dispatch.timeout.$$"
dispatch_run "$LIMIT_SECONDS" "$GRACE_SECONDS" "$TIMED_OUT" env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN "$CLAUDE_BIN" -p "$PROMPT" \
  --permission-mode acceptEdits \
  --allowedTools Read Edit Write Glob Grep Skill "Bash(gtm:*)" "Bash(./bin/gtm:*)" "Bash(pnpm:*)" "Bash(node:*)" "Bash(python3:*)" "Bash(ffmpeg:*)" "Bash(git:*)" "Bash(bin/vibrana:*)" \
  --disallowedTools "${DENY[@]}" \
  --output-format text
CODE=$?
if [ -e "$TIMED_OUT" ]; then REASON="stopped at the ${LIMIT_SECONDS}s limit before finishing"; rm -f "$TIMED_OUT"
elif [ "$CODE" -ne 0 ]; then REASON="the run exited with code $CODE before finishing"
else REASON=""; fi
if [ -n "$REASON" ]; then
  gtm work next --ended "$PIECE" --note "$REASON" || say "could not mark $PIECE blocked"
  say "end $PIECE: $REASON"
else
  say "end $PIECE exit 0"
fi
