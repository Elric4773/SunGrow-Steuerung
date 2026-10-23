#!/bin/sh
# Sungrow Steuerung – (C) by Elric M. – nur private Nutzung zu Test- und Lernzwecken, siehe LICENSE
# Richtet die Sungrow Steuerung als Dienst ein (als root ausführen):
#   1. Autostart beim Hochfahren der NAS   -> /usr/local/etc/rc.d/sungrow-steuerung.sh
#   2. Wächter alle 5 Minuten              -> Zeile in /etc/crontab
# Entfernen:  sh install-dienst.sh entfernen
DIR="$(cd "$(dirname "$0")" && pwd)"
RCD="${RCD:-/usr/local/etc/rc.d}"
CRONTAB="${CRONTAB:-/etc/crontab}"
RC="$RCD/sungrow-steuerung.sh"
MARK="$DIR/watchdog.sh"

if [ "$(id -u)" != "0" ]; then echo "Bitte als root ausfuehren."; exit 1; fi

cron_reload() {
  if command -v systemctl >/dev/null 2>&1; then systemctl restart crond 2>/dev/null || systemctl restart cron 2>/dev/null
  elif command -v synoservice >/dev/null 2>&1; then synoservice -restart crond 2>/dev/null
  fi
}

if [ "$1" = "entfernen" ]; then
  rm -f "$RC"
  if [ -f "$CRONTAB" ]; then grep -v "$MARK" "$CRONTAB" > "$CRONTAB.tmp" && cat "$CRONTAB.tmp" > "$CRONTAB"; rm -f "$CRONTAB.tmp"; fi
  cron_reload
  echo "Autostart und Waechter entfernt. Die laufende Steuerung wurde nicht beendet (dafuer: sh stop.sh)."
  exit 0
fi

# 1. Autostart
mkdir -p "$RCD"
cat > "$RC" <<RCEOF
#!/bin/sh
# Sungrow Steuerung: wird von DSM beim Hochfahren mit "start" und beim Herunterfahren mit "stop" aufgerufen
case "\$1" in
  start) sh "$DIR/start.sh" ;;
  stop)  sh "$DIR/stop.sh" quiet ;;
esac
exit 0
RCEOF
chmod 755 "$RC"
echo "Autostart eingerichtet: $RC"

# 2. Wächter (Synology verlangt Tabulatoren zwischen den Feldern)
if [ ! -f "$CRONTAB" ]; then echo "FEHLER: $CRONTAB nicht gefunden, Waechter nicht eingerichtet."; exit 1; fi
cp "$CRONTAB" "$CRONTAB.sungrow-sicherung"
grep -v "$MARK" "$CRONTAB" > "$CRONTAB.tmp"
printf '*/5\t*\t*\t*\t*\troot\t/bin/sh %s/watchdog.sh\n' "$DIR" >> "$CRONTAB.tmp"
cat "$CRONTAB.tmp" > "$CRONTAB"; rm -f "$CRONTAB.tmp"
cron_reload
echo "Waechter eingerichtet: alle 5 Minuten (Sicherung der alten crontab: $CRONTAB.sungrow-sicherung)"

# 3. sofort sicherstellen, dass er läuft
sh "$DIR/watchdog.sh"
echo "Fertig. Pruefen mit:  netstat -tlnp | grep node"
