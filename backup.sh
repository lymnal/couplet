#!/usr/bin/env bash
# Back up everything a parlor holds: room state, the Four Things archive,
# the notes wall, the Inklings record, the framed photo — and, if the parlor
# carries one, its custom deck.
#
# The free Supabase tier has no automated backups, so this is the only copy.
#
#   ./backup.sh CODE                     back up that parlor into ./backups
#   ./backup.sh --install CODE [MIRROR]  schedule it twice a week (Mon+Thu 11:00)
#   ./backup.sh --uninstall              remove the schedule
#
# The twice-weekly cadence is deliberate: each run reads the backend, which
# also counts as activity — a second guard against the free tier pausing the
# project, independent of the GitHub keepalive workflow.
#
# MIRROR is an optional second copy off this machine (an iCloud/Drive-synced
# folder). A backup on one laptop is one spilled coffee away.
#
# Exits non-zero on failure so launchd's log shows a real error rather than
# a silent no-op.
set -euo pipefail
cd "$(dirname "$0")"

PLIST="$HOME/Library/LaunchAgents/com.couplet.backup.plist"
LABEL="com.couplet.backup"
KEEP=24 # backups to retain (twice weekly ≈ 3 months)

# macOS blocks background agents from reading ~/Documents (TCC), so the
# scheduled copy of this script lives — and writes — outside it.
AGENT_HOME="$HOME/Library/Application Support/Couplet"

install_agent() {
  local room="${1:?usage: ./backup.sh --install CODE [MIRROR_DIR]}"
  local mirror="${2:-}"
  mkdir -p "$HOME/Library/LaunchAgents" "$AGENT_HOME/backups"
  # single source of truth: this script is copied to the unprotected home.
  # Re-run --install after editing it.
  cp "$0" "$AGENT_HOME/backup.sh"
  chmod +x "$AGENT_HOME/backup.sh"
  local url key
  url=$(sed -n 's/.*supabaseUrl: "\(.*\)",/\1/p' config.js)
  key=$(sed -n 's/.*supabaseKey: "\(.*\)",/\1/p' config.js)
  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${AGENT_HOME}/backup.sh</string>
    <string>${room}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>COUPLET_URL</key><string>${url}</string>
    <key>COUPLET_KEY</key><string>${key}</string>
    <key>COUPLET_BACKUP_DIR</key><string>${AGENT_HOME}/backups</string>
    <key>COUPLET_BACKUP_MIRROR</key><string>${mirror}</string>
  </dict>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>11</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Weekday</key><integer>4</integer><key>Hour</key><integer>11</integer><key>Minute</key><integer>0</integer></dict>
  </array>
  <key>StandardOutPath</key><string>${AGENT_HOME}/backups/backup.log</string>
  <key>StandardErrorPath</key><string>${AGENT_HOME}/backups/backup.log</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
PLIST_EOF
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "twice-weekly backup installed → Mon + Thu, 11:00"
  echo "backups: $AGENT_HOME/backups"
  [ -n "$mirror" ] && echo "mirror:  $mirror"
  echo "log:     $AGENT_HOME/backups/backup.log"
  exit 0
}

uninstall_agent() {
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  rm -f "$PLIST"
  echo "scheduled backup removed"
  exit 0
}

case "${1:-}" in
  --install) shift; install_agent "$@" ;;
  --uninstall) uninstall_agent ;;
esac

ROOM="${1:?usage: ./backup.sh CODE  (your parlor code)}"
URL="${COUPLET_URL:-$(sed -n 's/.*supabaseUrl: "\(.*\)",/\1/p' config.js 2>/dev/null)}"
KEY="${COUPLET_KEY:-$(sed -n 's/.*supabaseKey: "\(.*\)",/\1/p' config.js 2>/dev/null)}"
[ -z "$URL" ] && { echo "no supabase URL (set COUPLET_URL, or run from the repo)"; exit 1; }

STAMP=$(date +%F)
ROOT="${COUPLET_BACKUP_DIR:-backups}"
DIR="$ROOT/$STAMP"
mkdir -p "$DIR"
echo "[$(date '+%F %T')] backing up $ROOM"

rpc() {
  curl -sf --max-time 60 -X POST "$URL/rest/v1/rpc/$1" \
    -H "apikey: $KEY" -H "Content-Type: application/json" -d "$2"
}

fetch() { # fetch <rpc> <json-args> <outfile>
  if ! rpc "$1" "$2" > "$DIR/$3"; then
    echo "FAILED: $1 (network down, or the parlor code is wrong)"
    exit 1
  fi
}

fetch get_room     "{\"p_code\":\"$ROOM\"}"                      room.json
fetch get_four     "{\"p_code\":\"$ROOM\"}"                      four_things.json
fetch get_notes    "{\"p_code\":\"$ROOM\"}"                      notes.json
fetch get_inklings "{\"p_code\":\"$ROOM\"}"                      inklings.json
fetch get_keepsake "{\"p_code\":\"$ROOM\",\"p_kind\":\"photo\"}" photo.raw
fetch get_keepsake "{\"p_code\":\"$ROOM\",\"p_kind\":\"deck\"}"  deck-id.raw

# an unknown parlor code returns null for everything — catch it rather than
# quietly writing a directory full of nothing
if [ "$(cat "$DIR/room.json")" = "null" ]; then
  echo "FAILED: parlor $ROOM has no room state — wrong code?"
  exit 1
fi

# get_keepsake returns a JSON string; store the photo UNQUOTED so a restore
# can insert it verbatim (importing the quoted form once broke the <img>)
python3 - "$DIR" <<'PY'
import json, os, sys
d = sys.argv[1]
for raw, out in [("photo.raw", "photo.dataurl"), ("deck-id.raw", "deck-id.txt")]:
    p = os.path.join(d, raw)
    try:
        v = json.load(open(p))
    except Exception:
        v = None
    if v:
        open(os.path.join(d, out), "w").write(v)
    os.remove(p)
PY

# photo.dataurl -> a real viewable jpeg
if [ -s "$DIR/photo.dataurl" ]; then
  sed 's/^data:image\/[a-z]*;base64,//' < "$DIR/photo.dataurl" \
    | base64 -d > "$DIR/photo.jpg" 2>/dev/null || true
fi

# a parlor with a custom deck: capture the deck too, or a restore can't
# reproduce what the games actually showed
if [ -s "$DIR/deck-id.txt" ]; then
  fetch get_deck "{\"p_id\":\"$(cat "$DIR/deck-id.txt")\"}" deck.json
fi

# report what was actually captured, so a silently-empty backup is obvious
python3 - "$DIR" <<'PY'
import json, os, sys
d = sys.argv[1]
def n(f):
    p = os.path.join(d, f)
    if not os.path.exists(p): return "none"
    try:
        v = json.load(open(p))
    except Exception:
        return "unreadable"
    return len(v) if isinstance(v, list) else ("present" if v else "empty")
photo = os.path.join(d, "photo.jpg")
print(f"  room state : {n('room.json')}")
print(f"  four things: {n('four_things.json')} entries")
print(f"  notes      : {n('notes.json')}")
print(f"  inklings   : {n('inklings.json')}")
print(f"  photo      : {os.path.getsize(photo)//1024}KB" if os.path.exists(photo) else "  photo      : none")
deck = os.path.join(d, "deck-id.txt")
print(f"  deck       : {open(deck).read().strip()} ({n('deck.json')})" if os.path.exists(deck) else "  deck       : default content")
PY

# off-machine copy
MIRROR="${COUPLET_BACKUP_MIRROR:-}"
if [ -n "$MIRROR" ]; then
  mkdir -p "$MIRROR"
  if cp -R "$DIR" "$MIRROR/" 2>/dev/null; then
    echo "  mirrored   : $MIRROR/$STAMP"
  else
    echo "  mirror FAILED: $MIRROR"
  fi
fi

# keep the most recent $KEEP, drop older ones
total=$(ls -1d "$ROOT"/20* 2>/dev/null | wc -l | tr -d ' ')
if [ "$total" -gt "$KEEP" ]; then
  ls -1d "$ROOT"/20* | sort | head -n "$((total - KEEP))" | while read -r old; do
    rm -rf "$old"
    echo "  pruned     : $old"
  done
fi

echo "[$(date '+%F %T')] done → $DIR"
