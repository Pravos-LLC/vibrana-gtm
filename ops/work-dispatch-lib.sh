# shellcheck shell=bash
# Pieces of ops/work-dispatch.sh that are tested on their own (test/work-dispatch-shell.test.ts). Sourced, never run.

# The Vibrana hub that holds a directory: the nearest ancestor with vibrana.json, the way the hub's hooks find it. A
# vibrana-gtm worktree sits at <hub>/vibrana-gtm-worktrees/<task>, so "the parent directory" is not the hub there.
dispatch_hub() {
  local d
  d="$(cd "${1:-$PWD}" 2>/dev/null && pwd -P)" || return 1
  while [ "$d" != "/" ]; do
    [ -f "$d/vibrana.json" ] && { echo "$d"; return 0; }
    d="$(dirname "$d")"
  done
  return 1
}

# A process's start time, which tells a live process from a later one that reused its pid. One word ("Sat_Oct_17_
# 17:45:19_2026"), so a recorded "pid|start" entry survives word splitting.
dispatch_started() { ps -o lstart= -p "$1" 2>/dev/null | awk '{$1=$1; gsub(/ /, "_"); print}'; }

# Every process under a pid, depth first, as "pid|start time". Claude Code starts each Bash tool shell detached (its
# own process group), so signalling the run's group misses the ffmpeg or pnpm an agent started; the tree has to be
# read before the run dies, since its children are reparented after that.
dispatch_tree() {
  local p t
  for p in $(pgrep -P "$1" 2>/dev/null); do
    t="$(dispatch_started "$p")"
    [ -n "$t" ] && echo "$p|$t"
    dispatch_tree "$p"
  done
}

# The recorded processes that are still the same processes (pid alive, same start time), one pid per line.
dispatch_live() {
  local e
  for e in "$@"; do [ -n "$(dispatch_started "${e%%|*}")" ] && [ "${e#*|}" = "$(dispatch_started "${e%%|*}")" ] && echo "${e%%|*}"; done
  return 0
}

# Sends a signal to a run's process group and, for each recorded "pid|start time" that is still that process, to the
# process and its own group (a detached Bash tool shell leads a group, which also holds anything it started after the
# snapshot). A pid reused by another process since the snapshot is left alone.
dispatch_signal() {
  local sig=$1 group=$2 p
  shift 2
  kill "-$sig" -- "-$group" 2>/dev/null
  for p in $(dispatch_live "$@"); do kill "-$sig" "$p" 2>/dev/null; kill "-$sig" -- "-$p" 2>/dev/null; done
  return 0
}

# Runs a command in its own process group with a time limit, and returns its exit code. At the limit: record every
# process under it, TERM them all, wait up to GRACE seconds for the run and the recorded processes to go, then KILL
# whatever is left. The watcher does all of it, so the limit holds even when the command ignores TERM (then `wait`
# only returns after the KILL). MARK is created when the limit was hit.
#   dispatch_run LIMIT GRACE MARK command [args...]
dispatch_run() {
  local limit=$1 grace=$2 mark=$3 run watch code
  shift 3
  rm -f "$mark"
  set -m
  "$@" &
  run=$!
  set +m
  ( sleep "$limit"
    if kill -0 "$run" 2>/dev/null; then
      dispatch_tree "$run" >"$mark"
      # shellcheck disable=SC2046
      dispatch_signal TERM "$run" $(cat "$mark")
      local waited=0
      # shellcheck disable=SC2046
      while [ "$waited" -lt "$grace" ] && { kill -0 "$run" 2>/dev/null || [ -n "$(dispatch_live $(cat "$mark"))" ]; }; do sleep 1; waited=$((waited + 1)); done
      # shellcheck disable=SC2046
      dispatch_signal KILL "$run" $(cat "$mark")
    fi ) &
  watch=$!
  wait "$run"; code=$?
  if [ -e "$mark" ]; then wait "$watch" 2>/dev/null
  else { pkill -P "$watch"; kill "$watch"; wait "$watch"; } 2>/dev/null; fi
  return "$code"
}

# The --disallowedTools patterns, one per line. Deny wins over allow: nothing a dispatched run may do schedules,
# publishes, releases a hold, sends a link, reply or email, or pushes or merges code, by any spelling the allowlist
# lets through (git global options before push, pnpm run/tsx/-C/--filter, npx, node cli/gtm.ts, the bin/gtm paths).
dispatch_deny() {
  local c g
  for c in schedule autoschedule release hold reviewer engage outreach publish send push calendar candidates "signals digest" "report weekly"; do
    for g in "gtm" "./bin/gtm" "bin/gtm" "vibrana-gtm/bin/gtm" "pnpm gtm" "pnpm run gtm" "pnpm tsx cli/gtm.ts" "npx tsx cli/gtm.ts" \
      "node node_modules/.bin/tsx cli/gtm.ts" "node cli/gtm.ts" "node ./cli/gtm.ts" "node vibrana-gtm/cli/gtm.ts"; do
      echo "Bash($g $c:*)"
    done
  done
  # Package scripts and runners the run has no reason to call, and the git spellings that reach push or merge.
  printf '%s\n' "Bash(pnpm gtm:*)" "Bash(pnpm run:*)" "Bash(pnpm tsx:*)" "Bash(pnpm exec:*)" "Bash(pnpm dlx:*)" \
    "Bash(pnpm -C:*)" "Bash(pnpm --dir:*)" "Bash(pnpm --filter:*)" "Bash(npx:*)" \
    "Bash(git push:*)" "Bash(git merge:*)" "Bash(git -C:*)" "Bash(git -c:*)" "Bash(git --git-dir:*)" "Bash(git --work-tree:*)" \
    "Bash(git --no-pager:*)" "Bash(git -P:*)" "Bash(git -p:*)" "Bash(git --paginate:*)" "Bash(git --exec-path:*)" "Bash(git --namespace:*)" "Bash(git --bare:*)" \
    "Bash(gh:*)" "Bash(gog:*)" "Bash(wacli:*)" "Bash(slack:*)"
}
