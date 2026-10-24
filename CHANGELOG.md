# Änderungen

Sungrow Steuerung – (C) by Elric M. – nur private Nutzung zu Test- und Lernzwecken, siehe LICENSE.

## 1.3.1 – 24.10.2026

**Wechselrichter**
- Mikrowechselrichter der S-Serie (S1600S) als eigener Gerätetyp mit eigener Registerkarte (52xx/53xx/56xx, Modbus TCP
  über das WLAN des Geräts). Zählt wie ein String zu Solar und Hausverbrauch; Tagesertrag aus dem Gesamtzähler seit
  Mitternacht. Danke an die Registerliste aus dem Forum.

**Messgeräte**
- Neue Rolle „Erzeuger“ für Mikrowechselrichter und andere Erzeugung, die der Hybridwechselrichter nicht kennt
  (z. B. Sungrow S1600S, nur per Cloud erreichbar): ein Shelly, SDM120 oder Loxone-Zähler an deren Leitung liefert die
  Leistung; sie kommt zu Solar **und** zum Hausverbrauch dazu, weil der Hybrid fremde Einspeisung als eigene verbucht
  und seine Hauslast sonst zu niedrig ausweist.
- Tagesenergie je Messgerät wird mitgezählt und in `data/messgeraete-tag.json` gemerkt (überlebt Neustarts); bei
  Erzeugern fließt sie in „Solar heute“ und ins Lernen der PV-Prognose.
- Monitor zeigt den Erzeuger-Anteil unter „Solar gesamt“, der Energiefluss im Planer am Solar-Knoten.

**Energiefluss**
- Neuer Abschnitt „Energiefluss“ auf der Seite Anlage: Quelle je Knoten wählbar (Haus, Wärmepumpe, E-Auto – automatisch,
  Wechselrichter, Regler, bestimmtes Messgerät oder ausblenden) mit Live-Vorschau der Grafik, die die Wahl sofort zeigt.
- Grafik in `public/flow.js` zusammengeführt (Planer und Anlage zeichnen dieselbe).
- Haus-Knoten zeigt den Verbrauch ohne Wärmepumpe und E-Auto, die Summe steht klein darunter.

**Werkzeuge**
- `zaehlertest.js`: Konsolenwerkzeug, das Loxone-Zähler und Wechselrichterwerte im Takt nebeneinander zeigt, um
  vertauschte oder falsch sitzende Zähler zu erkennen.

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
