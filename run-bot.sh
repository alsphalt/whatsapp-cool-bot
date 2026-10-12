#!/usr/bin/env bash
#
# Start DARKNOTE in the background with a controllable stdin FIFO and a console log.
#
#   bash run-bot.sh              -> logs/console.log
#   bash run-bot.sh other.log    -> logs/other.log
#
# Why a FIFO: the Pair Panel reads from stdin, so a plain background start would
# leave it unable to answer prompts. The FIFO can be written to later with:
#   printf '1\n' > .stdin.fifo
#
# Why inside the project: /tmp is wiped whenever the runtime container is
# replaced, which took the previous log and FIFO with it.
set -u

BOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_NAME="${1:-console.log}"
LOG="$BOT_DIR/logs/$LOG_NAME"
FIFO="$BOT_DIR/.stdin.fifo"

mkdir -p "$BOT_DIR/logs"
[ -p "$FIFO" ] || mkfifo -m 600 "$FIFO"

# Never run two instances: they would share the session and the FIFO.
for pid in $(pgrep -f "node index.js" 2>/dev/null); do
    kill -9 "$pid" 2>/dev/null && echo "killed previous instance $pid"
done
sleep 2

cd "$BOT_DIR" || exit 1
setsid nohup bash -c "exec 3<>'$FIFO'; exec node index.js <'$FIFO' >>'$LOG' 2>&1" >/dev/null 2>&1 &

for i in $(seq 1 30); do
    sleep 2
    if sed -e 's/\x1b\[[0-9;]*m//g' "$LOG" 2>/dev/null | grep -q "Connected to WhatsApp"; then
        echo "CONNECTED after ~$((i * 2))s"
        echo "log: $LOG"
        echo "fifo: $FIFO"
        exit 0
    fi
done

echo "NOT CONNECTED within 60s — tail of $LOG:"
sed -e 's/\x1b\[[0-9;]*m//g' "$LOG" 2>/dev/null | tail -20
exit 1
