#!/usr/bin/env bash
#
# Drive the Pair Panel for one number and print the resulting console output.
#
#   bash pair-code.sh 254734641791
#
# Starts the bot if it is not already running, answers option 1 of the panel,
# submits the number, and shows the tail of the log (including the pairing code).
# The two writes are deliberately separated: writing "1" and the number in one
# chunk makes readline drop the second line, because it is emitted before the
# next question is registered.
set -u

BOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NUMBER="${1:-}"
LOG="$BOT_DIR/logs/pair.log"
FIFO="$BOT_DIR/.stdin.fifo"

if [ -z "$NUMBER" ]; then
    echo "usage: bash pair-code.sh <international-number-without-plus>"
    exit 2
fi

mkdir -p "$BOT_DIR/logs"
[ -p "$FIFO" ] || mkfifo -m 600 "$FIFO"

cd "$BOT_DIR" || exit 1

# ALWAYS restart. A previous instance may still hold this log's inode after the
# file was replaced, in which case its output goes nowhere and the panel looks
# dead even though it is running and swallowing input.
for pid in $(pgrep -f "node index.js" 2>/dev/null); do
    kill -9 "$pid" 2>/dev/null && echo "stopped previous instance $pid"
done
sleep 2
: > "$LOG"

echo "starting DARKNOTE..."
setsid nohup bash -c "exec 3<>'$FIFO'; exec node index.js <'$FIFO' >>'$LOG' 2>&1" >/dev/null 2>&1 &
sleep 14

printf '1\n' > "$FIFO"
sleep 6
printf '%s\n' "$NUMBER" > "$FIFO"
sleep 20

echo "----- console tail -----"
sed -e 's/\x1b\[[0-9;]*m//g' "$LOG" | tail -30
