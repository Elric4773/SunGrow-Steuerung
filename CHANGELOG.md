# Änderungen

Sungrow Steuerung – (C) by Elric M. – nur private Nutzung zu Test- und Lernzwecken, siehe LICENSE.

## 1.3 – 24.10.2026

**Wechselrichter**
- Modellauswahl aus allen Sungrow-Reihen (SH-RT, SH-T, SH-RS, SG-RT, SG-RS, SG-CX) mit vorbelegter Nennleistung und Registerkarte.

**Messgeräte**
- Neuer Abschnitt „Messgeräte“ auf der Seite Anlage: Leistungsmesser mit Rolle (Haus, Wärmepumpe, E-Auto, Verbraucher)
  und drei Quellen: Modbus (TCP oder RTU über TCP, Vorlagen für Eastron SDM630/SDM120/SDM72), Loxone Miniserver
  (`/jdev/sps/io/<Objektname>`) und HTTP/JSON (Shelly, Tasmota, Wallboxen).
- Gemessene Werte haben Vorrang: Haus ersetzt den gerechneten Hausverbrauch, Wärmepumpe fließt in die gelernte
  Heizlast, E-Auto wird aus dem Lastprofil herausgerechnet.
- Energiefluss zeigt E-Auto als Knoten, freie Verbraucher als Liste.
- Rolle „Erzeuger“ für Mikrowechselrichter und andere Erzeugung, die der Hybrid nicht kennt: Leistung kommt zu Solar
  und zum Hausverbrauch dazu, Tagesenergie wird mitgezählt (`data/messgeraete-tag.json`).

**Planer**
- Horizont bis 72 Stunden; unbekannte Preise werden aus dem Wochentagsmuster geschätzt (vier Wochen, Ersatz sieben Tage).
- Wochenausblick: sieben Tage mit Solarertrag, Verbrauch, Temperatur, Heiztagen, mittlerem Preis und Bilanz.
- Wetterprognose für sieben statt drei Tage; Tagesgrenzen über Kalendertage (Zeitumstellung).

**Oberfläche**
- Zeitband als Raum mit Rückwand, Boden und Tiefenlinien; zwei Darstellungen, umschaltbar und je Browser gemerkt:
  Relief (geglättete Preislandschaft) und Quader (feine Balken mit Preisschattierung).
- Harmonisierte Palette (Blau Netz, Teal Batterie, Amber Solar, Violett Wärme, Preis neutral), geprüft auf
  Farbenfehlsichtigkeit und Kontrast.
- Skins: Wie das System, Hell, Dunkel, Nacht, Sand; Sonne/Mond-Knopf für Hell/Dunkel. Neues Menü als schwebende Leiste.
- Energiefluss-Kachel mit animierten Flusslinien; Karten mit Tiefe.

**Betrieb**
- Dockerfile, docker-compose.yml, GitHub-Workflow für ghcr.io (amd64, arm64).
- Umgebungsvariable `SUNGROW_CONFIG_DIR` für einen eigenen Daten- und Konfigurationsordner.
- Batterie über Modbus: Adresse und Port frei wählbar (z. B. Modbus-Proxy auf Port 5020).

## 1.2 – 23.10.2026

- Planer: Fahrplan für Batterie und Wärmepumpe aus Strompreis (aWATTar/Energy-Charts plus feste Bestandteile),
  PV-Prognose (Open-Meteo oder forecast.solar, lernend) und Lastprofil; Betriebsarten Aus, Simulation, Aktiv.
- Wärmepumpe über Modbus (RTU über TCP oder Modbus TCP), Registerkarte Weishaupt WWP S / Carel pCO5+; geschrieben wird
  nur die Sollwert-Verschiebung PV (RAM), Weißliste im Code.
- Neue Seite Planer, neue Abschnitte Wärmepumpe, Strompreis, Prognose, Planer auf der Seite Anlage.

## 1.1 – 23.10.2026

- Seite Anlage: Einrichtung im Browser mit eigenem Passwort; mehrere Wechselrichter (ein Hybrid, beliebig viele
  Strings) mit frei wählbaren Registeradressen und Verbindungstest; Neustart nach dem Speichern.
- Alle persönlichen Einstellungen aus dem Code in `config.json` verlagert; Beispielkonfiguration, Installationsanleitung,
  Handbuch mit PDF.

## 1.0 – 10/2026

- Monitor mit Zellspannungen, Spreizung, Leistungsfluss, Verlauf, Energie und Balancing-Protokoll.
- Einstellungen des Hybridwechselrichters lesen und schreiben, Matching-Assistent für ein nachgerüstetes Modul.
