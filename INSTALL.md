# Installationsanleitung

Sungrow Steuerung – (C) by Elric M. – nur private Nutzung zu Test- und Lernzwecken, Benutzung auf eigene Gefahr.

Die Steuerung ist ein einzelnes Node.js-Programm ohne weitere Pakete. Sie läuft auf jedem Rechner im
Heimnetz, der den Wechselrichter erreicht und dauerhaft eingeschaltet ist: NAS, Raspberry Pi,
Linux-Server oder Windows-PC.

## 1. Voraussetzungen

| Was | Hinweis |
|---|---|
| Node.js 18 oder neuer | `node -v` zeigt die Version. Getestet mit Node.js 22. |
| Hybridwechselrichter SH-RT mit WiNet-S | Modbus TCP muss im lokalen Netz erreichbar sein (Port 502). |
| Feste IP-Adresse des WiNet-S | Im Router eine feste Zuordnung (DHCP-Reservierung) einrichten. |
| Zugangsdaten der WiNet-S-Weboberfläche | Nur für die Zellspannungen nötig. |
| optional: Stringwechselrichter SG-RT | ebenfalls per Modbus TCP, eigene IP-Adresse. |
| optional: Mikrowechselrichter S1600S | Modbus TCP über das WLAN des Geräts, Port 502, Unit 1. |
| optional: Wärmepumpe | RS485-Ethernet-Umsetzer am BMS-Anschluss des Reglers (Carel pCO5+: Klemme J25 BMS2, Tx/Rx+ und Tx/Rx−, GND), Umsetzer im transparenten Betrieb mit den seriellen Einstellungen des Reglers. |
| optional: Planer | Internetzugang des Rechners für Börsenpreise und Wetter. |

> **Hinweis zum WiNet-S:** Er erlaubt nur eine Anmeldung an der Weboberfläche gleichzeitig. Solange die
> Steuerung Zellwerte liest, wirft sie andere Sitzungen (Browser, App des Installateurs) hinaus. Für eigene
> Arbeiten im WiNet-S gibt es im Monitor den Knopf **„WiNet-S freigeben“**.

## 2. Dateien kopieren

Den Inhalt des ZIP-Archivs in einen eigenen Ordner entpacken, zum Beispiel

- Synology: `/volume1/sungrow-steuerung`
- Linux / Raspberry Pi: `/opt/sungrow-steuerung`
- Windows: `C:\SungrowSteuerung`

Eine `config.json` wird **nicht** mitgeliefert. Sie entsteht beim ersten Speichern auf der Seite Anlage.
`config.beispiel.json` zeigt nur den Aufbau und wird nicht gelesen.

## 3. Erster Start

```sh
cd /pfad/zur/Steuerung
node server.js
```

Die Konsole meldet `Einrichtungsmodus` und die Adresse der Oberfläche. Jetzt im Browser

```
http://<IP-des-Rechners>:8787/anlage
```

öffnen und Schritt für Schritt einrichten:

1. **Passwort festlegen** (mindestens 8 Zeichen). Es schützt die Seite Anlage.
2. **Wechselrichter eintragen**: Name, Typ (Hybrid oder String), IP-Adresse, Port (Standard 502),
   Geräteadresse (Standard 1) und beim Hybrid die Nennleistung in Watt.
3. **„Verbindung testen“** – liest alle Register sofort aus, ohne zu speichern. Stimmen die Werte?
4. **Zellwerte**: Quelle „WiNet-S“ wählen, Benutzer und Passwort der WiNet-Weboberfläche eintragen,
   **„WiNet-S testen“**.
5. **Batterieturm**: Anzahl der Module und Nummer des obersten Moduls.
6. Optional **Wärmepumpe**, **Strompreis**, **Prognose** und **Planer** ausfüllen; jeder Abschnitt hat einen Test-Knopf.
   Der Planer startet am besten in der Betriebsart *Simulation*.
7. **„Speichern und neu starten“**. Die Steuerung schreibt `config.json` und startet sich selbst neu.
   Danach öffnet `http://<IP>:8787/` den Monitor.

Ab hier kann das Konsolenfenster geschlossen werden, wenn die Steuerung wie unten beschrieben im
Hintergrund läuft.

## 4. Dauerbetrieb einrichten

### Synology NAS (DSM 7)

1. Node.js im Paket-Zentrum installieren („Node.js v18“ oder neuer).
2. Per SSH als Administrator anmelden und einmalig als root ausführen:

   ```sh
   cd /volume1/sungrow-steuerung
   sudo sh install-dienst.sh
   ```

   Das richtet ein:
   - Autostart beim Hochfahren (`/usr/local/etc/rc.d/sungrow-steuerung.sh`)
   - einen Wächter alle 5 Minuten in `/etc/crontab`, der die Steuerung neu startet, falls sie nicht läuft
     oder seit 10 Minuten nichts mehr gemessen hat.
3. Prüfen: `netstat -tlnp | grep node` zeigt den Port 8787.

Entfernen: `sudo sh install-dienst.sh entfernen`. Von Hand: `sh start.sh` startet (oder startet neu),
`sh stop.sh` beendet. Das Protokoll steht in `data/steuerung.log`.

> Nach einem DSM-Update kann `/etc/crontab` zurückgesetzt sein. Dann `install-dienst.sh` erneut ausführen.

### Docker (NAS, Server, überall)

Fertiges Image aus der GitHub Container Registry oder selbst gebaut. Konfiguration und Daten liegen im Volume `/data`.

```sh
docker run -d --name sungrow-steuerung --restart unless-stopped \
  -p 8787:8787 -v $PWD/daten:/data -e TZ=Europe/Berlin \
  ghcr.io/DEIN-GITHUB-NAME/sungrow-steuerung:latest
```

Oder mit der mitgelieferten `docker-compose.yml`: `docker compose up -d`. Selbst bauen: `docker build -t sungrow-steuerung .`

Hinweise:
- Nach dem Speichern auf der Seite Anlage beendet sich das Programm (`SUNGROW_SUPERVISED=1` ist im Image gesetzt),
  Docker startet es mit `restart: unless-stopped` neu.
- Der Container läuft ohne root. Das Verzeichnis für `/data` muss für den Container beschreibbar sein
  (`chown 100:101 daten` bei Alpine-Images, oder einfach leer anlegen, Docker setzt die Rechte beim ersten Start).
- Ohne Docker lässt sich der Datenordner genauso trennen: Umgebungsvariable `SUNGROW_CONFIG_DIR=/pfad` setzen,
  dann liegen `config.json` und `data/` dort statt im Programmordner.
- Port ändern: `-p 9000:8787` genügt, der innere Port bleibt 8787. `PORT` als Umgebungsvariable gilt nur, solange in `config.json` kein Port gespeichert ist; danach zählt die Seite Anlage.

### Linux mit systemd (Raspberry Pi, Debian, Ubuntu)

Datei `/etc/systemd/system/sungrow-steuerung.service` anlegen:

```ini
[Unit]
Description=Sungrow Steuerung
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/sungrow-steuerung
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=SUNGROW_SUPERVISED=1
User=pi

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now sungrow-steuerung
journalctl -u sungrow-steuerung -f
```

`User` an den eigenen Benutzer anpassen; er braucht Schreibrecht im Programmordner.
`SUNGROW_SUPERVISED=1` sagt der Steuerung, dass systemd den Neustart nach dem Speichern übernimmt.

### Windows

Für einen Test reicht ein Doppelklick auf eine Verknüpfung mit `node server.js` im Programmordner. Für
den Dauerbetrieb als Windows-Dienst eignet sich zum Beispiel NSSM:

```bat
nssm install SungrowSteuerung "C:\Program Files\nodejs\node.exe" server.js
nssm set SungrowSteuerung AppDirectory C:\SungrowSteuerung
nssm set SungrowSteuerung AppEnvironmentExtra SUNGROW_SUPERVISED=1
nssm start SungrowSteuerung
```

Die Windows-Firewall muss eingehende Verbindungen auf Port 8787 erlauben, wenn andere Geräte im Heimnetz
die Oberfläche öffnen sollen.

## 5. Aktualisieren

1. Steuerung beenden (`sh stop.sh`, `systemctl stop …` oder Dienst anhalten).
2. Alle Programmdateien durch die neuen ersetzen – **außer** `config.json` und dem Ordner `data`.
3. Wieder starten.

Ältere `config.json` mit den Abschnitten `inverter` und `inverter2` werden beim Start automatisch
übernommen. Beim nächsten Speichern auf der Seite Anlage schreibt die Steuerung das neue Format.

## 6. Häufige Fragen

**Passwort der Seite Anlage vergessen?** Steuerung beenden, in `config.json` den Abschnitt `"admin"`
vollständig löschen, wieder starten. Beim nächsten Aufruf von `/anlage` wird ein neues Passwort festgelegt.

**Port 8787 ist belegt?** Auf der Seite Anlage einen anderen Port eintragen. Ohne laufende Oberfläche:
in `config.json` unter `"http": { "port": … }` ändern.

**„Wechselrichter antwortet nicht“** – IP-Adresse und Port prüfen, ob Modbus TCP am WiNet-S aktiv ist
und ob nicht ein anderes Programm gleichzeitig dauerhaft per Modbus abfragt.

**Was gehört nicht ins Internet / auf GitHub?** `config.json` (enthält IP-Adressen, das WiNet-Passwort
und den Passwort-Hash) und der Ordner `data`. Die mitgelieferte `.gitignore` schließt beides aus.
