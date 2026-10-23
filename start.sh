#!/bin/sh
# Sungrow Steuerung – (C) by Elric M. – nur private Nutzung zu Test- und Lernzwecken, siehe LICENSE
PATH="$PATH:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"; export PATH
# Startet die Steuerung im Hintergrund. Läuft sie schon, wird sie vorher sauber beendet.
cd "$(dirname "$0")" || exit 1
mkdir -p data
sh ./stop.sh quiet
nohup node server.js >> data/steuerung.log 2>&1 &
echo $! > data/steuerung.pid
echo "Sungrow Steuerung gestartet (PID $!)"
