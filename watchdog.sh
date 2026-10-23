#!/bin/sh
# Sungrow Steuerung – (C) by Elric M. – nur private Nutzung zu Test- und Lernzwecken, siehe LICENSE
PATH="$PATH:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"; export PATH
# Wächter: startet die Sungrow Steuerung nur dann, wenn sie nicht (mehr) läuft oder seit 10 Minuten nichts mehr misst.
# Gedacht für cron oder den DSM-Aufgabenplaner, alle 5 Minuten. Eine laufende Steuerung wird nicht angefasst.
cd "$(dirname "$0")" || exit 1
mkdir -p data
LAEUFT=0
# 1. Prüfung: gehört die gemerkte PID noch zu einem laufenden node-Prozess?
if [ -f data/steuerung.pid ]; then
  PID=$(cat data/steuerung.pid)
  if [ -n "$PID" ] && [ -d "/proc/$PID" ] && grep -q node "/proc/$PID/cmdline" 2>/dev/null; then
    LAEUFT=1
  fi
fi
# 2. Prüfung: lauscht jemand auf dem Port des Monitors?
PORT=$(grep -o '"port"[ ]*:[ ]*[0-9]*' config.json 2>/dev/null | head -1 | grep -o '[0-9]*$')
[ -z "$PORT" ] && PORT=8787
if netstat -tln 2>/dev/null | grep -q ":$PORT "; then
  LAEUFT=1
fi
if [ "$LAEUFT" = "1" ]; then
  # Der Prozess lebt. Kommen auch frische Messversuche? Alter des letzten Abfrageversuchs in Sekunden:
  ALTER=$(node -e "const q=require('http').get('http://127.0.0.1:$PORT/api/live',r=>{let b='';r.on('data',d=>b+=d);r.on('end',()=>{try{const j=JSON.parse(b);console.log(j.now&&j.lastTry?Math.round((j.now-j.lastTry)/1000):0)}catch(e){console.log(0)}})});q.on('error',()=>console.log(0));q.setTimeout(8000,()=>{console.log(9999);q.destroy()})" 2>/dev/null | head -1)
  [ -z "$ALTER" ] && ALTER=0
  if [ "$ALTER" -lt 600 ]; then exit 0; fi
  echo "$(date '+%d.%m.%Y %H:%M:%S') Waechter: seit $ALTER Sekunden kein Abfrageversuch mehr, starte neu" >> data/steuerung.log
  sh ./start.sh >> data/steuerung.log 2>&1
  exit 0
fi
echo "$(date '+%d.%m.%Y %H:%M:%S') Waechter: Steuerung lief nicht, starte neu" >> data/steuerung.log
sh ./start.sh >> data/steuerung.log 2>&1
