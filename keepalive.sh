#!/usr/bin/env bash
#
# keepalive.sh - keep DARKNOTE CONNECTED, by restarting it whenever it dies.
#
#   bash keepalive.sh                 start supervising (returns immediately)
#   bash keepalive.sh --foreground    supervise in this terminal instead
#
#   touch .keepalive.stop             stand the supervisor down (see STOPPING below)
#   rm .keepalive.stop                let it supervise again
#
# WHY THIS EXISTS
# ---------------
# lib/runtime.js deliberately EXITS on any uncaught exception or unhandled rejection. Its
# own comment says why: "Exit cleanly and let the Pterodactyl/panel supervisor start a fresh
# process with the same persisted auth." That is a reasonable design - a socket can look
# connected while its internal state is corrupt, and a fresh process with the same auth/ is
# the honest cure.
#
# But this runtime has NO panel supervisor. There is no cron and no service manager here, so
# nothing was restarting the bot. Every unhandled rejection therefore ended the session
# permanently, and it stayed dead until someone ran run-bot.sh by hand. This script IS the
# missing supervisor, so the exit-on-fatal design finally works as intended.
#
# WHAT IT CANNOT DO
# -----------------
# It cannot survive the runtime container being replaced - the process, this supervisor
# included, goes with the container. Nothing running inside that container can prevent it.
# What it does fix is everything else: crashes, unhandled rejections, a socket that dies,
# and a bot that starts but never manages to connect.
#
# STOPPING
# --------
# `touch .keepalive.stop` stands it down. Without that, killing the bot on purpose would
# just make the supervisor restart it, which is the right default for uptime and the wrong
# one for "stop the bot now".
set -u

BOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_NAME="console.log"
LOG="$BOT_DIR/logs/$LOG_NAME"
SUP_LOG="$BOT_DIR/logs/keepalive.log"
LOCK="$BOT_DIR/logs/keepalive.pid"
STOP_FILE="$BOT_DIR/.keepalive.stop"

# Escalating backoff, capped. Ten seconds first, because a quick crash is usually transient.
BACKOFF=(10 20 40 60 120 300)
# How long a connection must last before the backoff is considered recovered.
HEALTHY_SECONDS=120
# How long to wait for a NEW "connected to WhatsApp" line (any session) before treating
# the attempt as failed.
CONNECT_TIMEOUT=90

mkdir -p "$BOT_DIR/logs"
cd "$BOT_DIR" || exit 1

# Appends to the supervisor log itself, and only echoes when a terminal is attached. The
# detached child already has its stdout pointed at this same file (so bash's own errors are
# not lost), so `tee` here would write every line twice.
say() {
    local line
    line="$(date '+%Y-%m-%d %H:%M:%S') [keepalive] $*"
    printf '%s\n' "$line" >> "$SUP_LOG"
    [ -t 1 ] && printf '%s\n' "$line"
    return 0
}

# Only node processes belonging to THIS checkout. A blanket pgrep also matches a sibling
# checkout's bot, and the whole point is that the two projects never touch each other.
bot_pids() {
    local pid
    for pid in $(pgrep -f "node index.js" 2>/dev/null); do
        [ "$(readlink -f "/proc/$pid/cwd" 2>/dev/null)" = "$BOT_DIR" ] && echo "$pid"
    done
}

stopped() { [ -e "$STOP_FILE" ]; }

detach=1
for arg in "$@"; do
    [ "$arg" = "--foreground" ] && detach=0
done

# ---- one supervisor per checkout ----
# Checked BEFORE spawning, so a second `bash keepalive.sh` cannot start a rival supervisor.
# The lock is written by the process that actually supervises - writing it here instead
# would mean the detached child sees a live pid (this one) and stands down immediately.
if [ -f "$LOCK" ]; then
    existing="$(cat "$LOCK" 2>/dev/null || true)"
    if [ -n "$existing" ] && kill -0 "$existing" 2>/dev/null; then
        echo "keepalive is already running (pid $existing). Nothing to do."
        exit 0
    fi
    say "stale lock from pid ${existing:-?}; taking over"
    rm -f "$LOCK"
fi

if [ "$detach" = "1" ] && [ -z "${KEEPALIVE_CHILD:-}" ]; then
    KEEPALIVE_CHILD=1 setsid nohup bash "$BOT_DIR/keepalive.sh" --foreground >>"$SUP_LOG" 2>&1 &
    sleep 2
    if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
        echo "keepalive supervisor started (pid $(cat "$LOCK"))."
    else
        echo "keepalive supervisor FAILED to start - see $SUP_LOG"
        exit 1
    fi
    echo "log:  $SUP_LOG"
    echo "stop: touch $STOP_FILE"
    exit 0
fi

# From here on this process IS the supervisor, so it owns the lock and clears it on exit.
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

if stopped; then
    say "stop file present ($STOP_FILE) - not starting the bot. Remove it to resume."
    exit 0
fi

say "supervising $BOT_DIR (bot log: $LOG)"

attempt=0
while true; do
    if stopped; then
        say "stop file appeared - standing down without touching the running bot"
        exit 0
    fi

    # Remember where the log ended, so a STALE "Connected to WhatsApp" from a previous run
    # cannot be mistaken for this one having connected.
    before=0
    [ -f "$LOG" ] && before=$(wc -l < "$LOG")

    say "starting the bot (attempt $((attempt + 1)))"
    bash "$BOT_DIR/run-bot.sh" "$LOG_NAME" >/dev/null 2>&1
    runbot_exit=$?

    connected=0
    waited=0
    while [ "$waited" -lt "$CONNECT_TIMEOUT" ]; do
        sleep 3
        waited=$((waited + 3))
        stopped && { say "stop file appeared - standing down"; exit 0; }
        # -i matters: the PRIMARY session logs "Connected to WhatsApp" but a secondary
        # session logs "[s2] connected to WhatsApp" in lower case. Without -i the
        # secondary was invisible here, so on a bot whose primary was logged out the
        # supervisor saw every attempt as failed and killed a process that was in fact
        # serving a perfectly healthy session - every 90s, for ever, escalating.
        if tail -n +"$((before + 1))" "$LOG" 2>/dev/null | sed -e 's/\x1b\[[0-9;]*m//g' | grep -qi "connected to WhatsApp"; then
            connected=1
            break
        fi
        # Nothing to wait for if the process is already gone.
        [ -z "$(bot_pids)" ] && break
    done

    if [ "$connected" = "1" ]; then
        up_since=$(date +%s)
        say "connected after ~${waited}s - watching for the socket or the process to drop"
        while true; do
            sleep 10
            if stopped; then
                say "stop file appeared - standing down without touching the running bot"
                exit 0
            fi
            if [ -z "$(bot_pids)" ]; then
                say "bot process exited"
                break
            fi
        done
        up_for=$(( $(date +%s) - up_since ))
        if [ "$up_for" -ge "$HEALTHY_SECONDS" ]; then
            [ "$attempt" -ne 0 ] && say "stayed up ${up_for}s - backoff reset"
            attempt=0
        else
            say "only stayed up ${up_for}s"
        fi
    else
        say "attempt failed (run-bot.sh exit=$runbot_exit, connected=$connected within ${CONNECT_TIMEOUT}s)"
        for pid in $(bot_pids); do kill -9 "$pid" 2>/dev/null && say "killed partial instance $pid"; done
    fi

    delay=${BACKOFF[$attempt]:-300}
    attempt=$((attempt + 1))
    say "restarting in ${delay}s"
    sleep "$delay"
done
