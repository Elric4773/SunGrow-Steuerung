#!/bin/sh
# Sungrow Steuerung – (C) by Elric M. – nur private Nutzung zu Test- und Lernzwecken, siehe LICENSE
PATH="$PATH:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"; export PATH
# Beendet nur die Sungrow Steuerung, keine anderen node-Prozesse.
cd "$(dirname "$0")" || exit 1
PID=""
[ -f data/steuerung.pid ] && PID=$(cat data/steuerung.pid)
# PID-Datei prüfen: gehört die Nummer wirklich noch zu einem node-Prozess?
if [ -n "$PID" ] && [ -d "/proc/$PID" ] && grep -q node "/proc/$PID/cmdline" 2>/dev/null; then
  kill "$PID"
else
  # sonst über den Port suchen (Port aus config.json, Standard 8787)
  PORT=$(grep -o '"port"[ ]*:[ ]*[0-9]*' config.json 2>/dev/null | head -1 | grep -o '[0-9]*$')
  [ -z "$PORT" ] && PORT=8787
  PID=$(netstat -tlnp 2>/dev/null | grep ":$PORT " | awk '{print $7}' | cut -d/ -f1 | head -1)
  [ -n "$PID" ] && kill "$PID"
fi
rm -f data/steuerung.pid
if [ -n "$PID" ]; then sleep 1; [ "$1" = "quiet" ] || echo "Sungrow Steuerung beendet (PID $PID)"; else [ "$1" = "quiet" ] || echo "Sungrow Steuerung lief nicht"; fi
