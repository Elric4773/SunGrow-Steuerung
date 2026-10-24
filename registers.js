'use strict';
/*
 * Sungrow Steuerung – (C) by Elric M.
 * Nur für die private Nutzung zu Test- und Lernzwecken. Kommerzielle Verwendung jeder Art, die Verwendung im
 * Geschäftsbetrieb und der Weiterverkauf sind untersagt. Benutzung auf eigene Gefahr, ohne Gewährleistung oder Garantie.
 * Einzelheiten: LICENSE und HANDBUCH.md.
 */
/*
 * Registerkarten der unterstützten Sungrow-Wechselrichter und das Lesen nach Karte.
 *
 * Jeder Messwert und jede Einstellung hat einen festen Schlüssel (key). Die Adresse dazu kommt aus der Standardkarte und kann
 * je Wechselrichter in der Konfiguration überschrieben werden (inverters[].registers = { key: adresse }). Adressen sind
 * 0-basiert: Registernummer aus der Sungrow-Dokumentation minus 1.
 *
 *   fc     4 = Input-Register (Messwerte), 3 = Holding-Register (Einstellungen)
 *   type   u16, s16, u32, s32 (32 Bit: niederwertiges Wort zuerst, wie bei Sungrow üblich)
 *   scale  Faktor zur Anzeige, unit Einheit
 *   core   ohne diesen Wert ist eine Messung unbrauchbar
 */

const HYBRID = [
  // Solar, Netz, Gerät
  { key: 'pvPower',        group: 'Solar und Netz',      label: 'Solarleistung DC',              fc: 4, addr: 5016,  type: 'u32', scale: 1,    unit: 'W', core: true },
  { key: 'mppt1Voltage',   group: 'Solar und Netz',      label: 'Strang 1 Spannung',             fc: 4, addr: 5010,  type: 'u16', scale: 0.1,  unit: 'V' },
  { key: 'mppt1Current',   group: 'Solar und Netz',      label: 'Strang 1 Strom',                fc: 4, addr: 5011,  type: 'u16', scale: 0.1,  unit: 'A' },
  { key: 'mppt2Voltage',   group: 'Solar und Netz',      label: 'Strang 2 Spannung',             fc: 4, addr: 5012,  type: 'u16', scale: 0.1,  unit: 'V' },
  { key: 'mppt2Current',   group: 'Solar und Netz',      label: 'Strang 2 Strom',                fc: 4, addr: 5013,  type: 'u16', scale: 0.1,  unit: 'A' },
  { key: 'inverterTemp',   group: 'Solar und Netz',      label: 'Gerätetemperatur',              fc: 4, addr: 5007,  type: 's16', scale: 0.1,  unit: '°C' },
  { key: 'gridVoltage1',   group: 'Solar und Netz',      label: 'Netzspannung L1',               fc: 4, addr: 5018,  type: 'u16', scale: 0.1,  unit: 'V' },
  { key: 'gridVoltage2',   group: 'Solar und Netz',      label: 'Netzspannung L2',               fc: 4, addr: 5019,  type: 'u16', scale: 0.1,  unit: 'V' },
  { key: 'gridVoltage3',   group: 'Solar und Netz',      label: 'Netzspannung L3',               fc: 4, addr: 5020,  type: 'u16', scale: 0.1,  unit: 'V' },
  { key: 'gridFrequency',  group: 'Solar und Netz',      label: 'Netzfrequenz (0,1 oder 0,01 Hz)', fc: 4, addr: 5035, type: 'u16', scale: 0.1,  unit: 'Hz' },
  { key: 'systemState',    group: 'Solar und Netz',      label: 'Systemzustand',                 fc: 4, addr: 12999, type: 'u16', scale: 1,    unit: '' },
  { key: 'runningBits',    group: 'Solar und Netz',      label: 'Betriebsbits',                  fc: 4, addr: 13000, type: 'u16', scale: 1,    unit: '', core: true },
  { key: 'loadPower',      group: 'Solar und Netz',      label: 'Hauslast',                      fc: 4, addr: 13007, type: 's32', scale: 1,    unit: 'W', core: true },
  { key: 'exportPower',    group: 'Solar und Netz',      label: 'Einspeiseleistung (negativ = Bezug)', fc: 4, addr: 13009, type: 's32', scale: 1, unit: 'W', core: true },
  { key: 'acPower',        group: 'Solar und Netz',      label: 'AC-Wirkleistung',               fc: 4, addr: 13033, type: 's32', scale: 1,    unit: 'W', core: true },
  { key: 'phaseCurrent1',  group: 'Solar und Netz',      label: 'Phasenstrom L1',                fc: 4, addr: 13030, type: 's16', scale: 0.1,  unit: 'A' },
  { key: 'phaseCurrent2',  group: 'Solar und Netz',      label: 'Phasenstrom L2',                fc: 4, addr: 13031, type: 's16', scale: 0.1,  unit: 'A' },
  { key: 'phaseCurrent3',  group: 'Solar und Netz',      label: 'Phasenstrom L3',                fc: 4, addr: 13032, type: 's16', scale: 0.1,  unit: 'A' },
  // Batterie
  { key: 'battVoltage',    group: 'Batterie',            label: 'Batteriespannung',              fc: 4, addr: 13019, type: 'u16', scale: 0.1,  unit: 'V', core: true },
  { key: 'battCurrent',    group: 'Batterie',            label: 'Batteriestrom (Betrag)',        fc: 4, addr: 13020, type: 's16', scale: 0.1,  unit: 'A' },
  { key: 'battPower',      group: 'Batterie',            label: 'Batterieleistung (Betrag)',     fc: 4, addr: 13021, type: 's16', scale: 1,    unit: 'W' },
  { key: 'soc',            group: 'Batterie',            label: 'Ladezustand',                   fc: 4, addr: 13022, type: 'u16', scale: 0.1,  unit: '%', core: true },
  { key: 'soh',            group: 'Batterie',            label: 'Gesundheit (SOH)',              fc: 4, addr: 13023, type: 'u16', scale: 0.1,  unit: '%' },
  { key: 'battTemp',       group: 'Batterie',            label: 'Batterietemperatur',            fc: 4, addr: 13024, type: 's16', scale: 0.1,  unit: '°C' },
  { key: 'battCapacity',   group: 'Batterie',            label: 'Batteriekapazität',             fc: 4, addr: 13038, type: 'u16', scale: 0.01, unit: 'kWh' },
  { key: 'bmsMaxCharge',   group: 'Batterie',            label: 'Vom BMS erlaubter Ladestrom',   fc: 4, addr: 5634,  type: 'u16', scale: 1,    unit: 'A' },
  { key: 'bmsMaxDischarge', group: 'Batterie',           label: 'Vom BMS erlaubter Entladestrom', fc: 4, addr: 5635, type: 'u16', scale: 1,    unit: 'A' },
  // Zähler
  { key: 'pvToday',        group: 'Tageswerte und Zähler', label: 'Solarertrag heute',           fc: 4, addr: 13001, type: 'u16', scale: 0.1,  unit: 'kWh' },
  { key: 'pvTotal',        group: 'Tageswerte und Zähler', label: 'Solarertrag gesamt',          fc: 4, addr: 13002, type: 'u32', scale: 0.1,  unit: 'kWh' },
  { key: 'battDischargeToday', group: 'Tageswerte und Zähler', label: 'Batterie entladen heute',  fc: 4, addr: 13025, type: 'u16', scale: 0.1,  unit: 'kWh' },
  { key: 'battDischargeTotal', group: 'Tageswerte und Zähler', label: 'Batterie entladen gesamt', fc: 4, addr: 13026, type: 'u32', scale: 0.1,  unit: 'kWh' },
  { key: 'selfConsumptionToday', group: 'Tageswerte und Zähler', label: 'Eigenverbrauchsanteil heute', fc: 4, addr: 13028, type: 'u16', scale: 0.1, unit: '%' },
  { key: 'importToday',    group: 'Tageswerte und Zähler', label: 'Netzbezug heute',             fc: 4, addr: 13035, type: 'u16', scale: 0.1,  unit: 'kWh' },
  { key: 'importTotal',    group: 'Tageswerte und Zähler', label: 'Netzbezug gesamt',            fc: 4, addr: 13036, type: 'u32', scale: 0.1,  unit: 'kWh' },
  { key: 'battChargeToday', group: 'Tageswerte und Zähler', label: 'Batterie geladen heute',     fc: 4, addr: 13039, type: 'u16', scale: 0.1,  unit: 'kWh' },
  { key: 'battChargeTotal', group: 'Tageswerte und Zähler', label: 'Batterie geladen gesamt',    fc: 4, addr: 13040, type: 'u32', scale: 0.1,  unit: 'kWh' },
  { key: 'exportToday',    group: 'Tageswerte und Zähler', label: 'Einspeisung heute',           fc: 4, addr: 13044, type: 'u16', scale: 0.1,  unit: 'kWh' },
  { key: 'exportTotal',    group: 'Tageswerte und Zähler', label: 'Einspeisung gesamt',          fc: 4, addr: 13045, type: 'u32', scale: 0.1,  unit: 'kWh' },
  // Einstellungen (Holding). Die Schlüssel sind dieselben wie auf der Seite Einstellungen.
  { key: 'emsMode',        group: 'Einstellungen',       label: 'Betriebsart',                   fc: 3, addr: 13049, type: 'u16', scale: 1,    unit: '' },
  { key: 'forcedCmd',      group: 'Einstellungen',       label: 'Befehl im Zwangsmodus',         fc: 3, addr: 13050, type: 'u16', scale: 1,    unit: '' },
  { key: 'forcedPower',    group: 'Einstellungen',       label: 'Leistung im Zwangsmodus',       fc: 3, addr: 13051, type: 'u16', scale: 1,    unit: 'W' },
  { key: 'maxSoc',         group: 'Einstellungen',       label: 'Obere Ladegrenze',              fc: 3, addr: 13057, type: 'u16', scale: 0.1,  unit: '%' },
  { key: 'minSoc',         group: 'Einstellungen',       label: 'Untere Entladegrenze',          fc: 3, addr: 13058, type: 'u16', scale: 0.1,  unit: '%' },
  { key: 'exportLimit',    group: 'Einstellungen',       label: 'Größte Einspeiseleistung',      fc: 3, addr: 13073, type: 'u16', scale: 1,    unit: 'W' },
  { key: 'exportEnable',   group: 'Einstellungen',       label: 'Einspeisebegrenzung (0xAA ein, 0x55 aus)', fc: 3, addr: 13086, type: 'u16', scale: 1, unit: '' },
  { key: 'backupReserve',  group: 'Einstellungen',       label: 'Reserve für Notstrom',          fc: 3, addr: 13099, type: 'u16', scale: 1,    unit: '%' },
  { key: 'maxCharge',      group: 'Einstellungen',       label: 'Größte Ladeleistung',           fc: 3, addr: 33046, type: 'u16', scale: 10,   unit: 'W' },
  { key: 'maxDischarge',   group: 'Einstellungen',       label: 'Größte Entladeleistung',        fc: 3, addr: 33047, type: 'u16', scale: 10,   unit: 'W' },
  { key: 'tcEnable',       group: 'Einstellungen',       label: 'Zwangsladung nach Zeitfenster (0xAA ein, 0x55 aus)', fc: 3, addr: 33207, type: 'u16', scale: 1, unit: '' },
  { key: 'tc1StartH',      group: 'Einstellungen',       label: 'Fenster 1 Beginn, Stunde',      fc: 3, addr: 33209, type: 'u16', scale: 1,    unit: 'h' },
  { key: 'tc1StartM',      group: 'Einstellungen',       label: 'Fenster 1 Beginn, Minute',      fc: 3, addr: 33210, type: 'u16', scale: 1,    unit: 'min' },
  { key: 'tc1EndH',        group: 'Einstellungen',       label: 'Fenster 1 Ende, Stunde',        fc: 3, addr: 33211, type: 'u16', scale: 1,    unit: 'h' },
  { key: 'tc1EndM',        group: 'Einstellungen',       label: 'Fenster 1 Ende, Minute',        fc: 3, addr: 33212, type: 'u16', scale: 1,    unit: 'min' },
  { key: 'tc1Target',      group: 'Einstellungen',       label: 'Fenster 1 Ziel-Ladezustand',    fc: 3, addr: 33213, type: 'u16', scale: 1,    unit: '%' },
  { key: 'tc2StartH',      group: 'Einstellungen',       label: 'Fenster 2 Beginn, Stunde',      fc: 3, addr: 33214, type: 'u16', scale: 1,    unit: 'h' },
  { key: 'tc2StartM',      group: 'Einstellungen',       label: 'Fenster 2 Beginn, Minute',      fc: 3, addr: 33215, type: 'u16', scale: 1,    unit: 'min' },
  { key: 'tc2EndH',        group: 'Einstellungen',       label: 'Fenster 2 Ende, Stunde',        fc: 3, addr: 33216, type: 'u16', scale: 1,    unit: 'h' },
  { key: 'tc2EndM',        group: 'Einstellungen',       label: 'Fenster 2 Ende, Minute',        fc: 3, addr: 33217, type: 'u16', scale: 1,    unit: 'min' },
  { key: 'tc2Target',      group: 'Einstellungen',       label: 'Fenster 2 Ziel-Ladezustand',    fc: 3, addr: 33218, type: 'u16', scale: 1,    unit: '%' }
];

const STRING = [
  { key: 'acPower',        group: 'Messwerte',           label: 'AC-Wirkleistung',               fc: 4, addr: 5030,  type: 'u32', scale: 1,    unit: 'W', core: true },
  { key: 'dcPower',        group: 'Messwerte',           label: 'DC-Leistung',                   fc: 4, addr: 5016,  type: 'u32', scale: 1,    unit: 'W' },
  { key: 'mppt1Voltage',   group: 'Messwerte',           label: 'Strang 1 Spannung',             fc: 4, addr: 5010,  type: 'u16', scale: 0.1,  unit: 'V' },
  { key: 'mppt1Current',   group: 'Messwerte',           label: 'Strang 1 Strom',                fc: 4, addr: 5011,  type: 'u16', scale: 0.1,  unit: 'A' },
  { key: 'mppt2Voltage',   group: 'Messwerte',           label: 'Strang 2 Spannung',             fc: 4, addr: 5012,  type: 'u16', scale: 0.1,  unit: 'V' },
  { key: 'mppt2Current',   group: 'Messwerte',           label: 'Strang 2 Strom',                fc: 4, addr: 5013,  type: 'u16', scale: 0.1,  unit: 'A' },
  { key: 'inverterTemp',   group: 'Messwerte',           label: 'Gerätetemperatur',              fc: 4, addr: 5007,  type: 's16', scale: 0.1,  unit: '°C' },
  { key: 'gridVoltage1',   group: 'Messwerte',           label: 'Netzspannung L1',               fc: 4, addr: 5018,  type: 'u16', scale: 0.1,  unit: 'V' },
  { key: 'gridVoltage2',   group: 'Messwerte',           label: 'Netzspannung L2',               fc: 4, addr: 5019,  type: 'u16', scale: 0.1,  unit: 'V' },
  { key: 'gridVoltage3',   group: 'Messwerte',           label: 'Netzspannung L3',               fc: 4, addr: 5020,  type: 'u16', scale: 0.1,  unit: 'V' },
  { key: 'phaseCurrent1',  group: 'Messwerte',           label: 'Phasenstrom L1',                fc: 4, addr: 5021,  type: 'u16', scale: 0.1,  unit: 'A' },
  { key: 'phaseCurrent2',  group: 'Messwerte',           label: 'Phasenstrom L2',                fc: 4, addr: 5022,  type: 'u16', scale: 0.1,  unit: 'A' },
  { key: 'phaseCurrent3',  group: 'Messwerte',           label: 'Phasenstrom L3',                fc: 4, addr: 5023,  type: 'u16', scale: 0.1,  unit: 'A' },
  { key: 'gridFrequency',  group: 'Messwerte',           label: 'Netzfrequenz (0,1 oder 0,01 Hz)', fc: 4, addr: 5035, type: 'u16', scale: 0.1,  unit: 'Hz' },
  { key: 'yieldToday',     group: 'Zähler',              label: 'Ertrag heute',                  fc: 4, addr: 5002,  type: 'u16', scale: 0.1,  unit: 'kWh' },
  { key: 'yieldTotal',     group: 'Zähler',              label: 'Ertrag gesamt',                 fc: 4, addr: 5003,  type: 'u32', scale: 1,    unit: 'kWh' }
];

/* Mikrowechselrichter der S-Serie (S1600S): Modbus TCP über das eingebaute WLAN, Port 502, Unit 1, eigene Registerfamilie
   52xx/53xx/56xx. Karte nach einer im Forum geteilten Home-Assistant-Konfiguration. Kein Tagesertrag-Register: der
   Tageswert wird aus dem Gesamtzähler seit Mitternacht gebildet. */
const MICRO = [
  { key: 'acPower',        group: 'Messwerte',           label: 'AC-Wirkleistung',               fc: 4, addr: 5231,  type: 'u16', scale: 1,    unit: 'W', core: true },
  { key: 'dcPower',        group: 'Messwerte',           label: 'DC-Leistung gesamt',            fc: 4, addr: 5235,  type: 'u16', scale: 1,    unit: 'W' },
  { key: 'runningState',   group: 'Messwerte',           label: 'Betriebszustand',               fc: 4, addr: 5220,  type: 'u16', scale: 1,    unit: '' },
  { key: 'mppt1Voltage',   group: 'Messwerte',           label: 'PV1 Spannung',                  fc: 4, addr: 5332,  type: 'u16', scale: 0.1,  unit: 'V' },
  { key: 'mppt1Current',   group: 'Messwerte',           label: 'PV1 Strom',                     fc: 4, addr: 5333,  type: 'u16', scale: 0.1,  unit: 'A' },
  { key: 'mppt2Voltage',   group: 'Messwerte',           label: 'PV2 Spannung',                  fc: 4, addr: 5334,  type: 'u16', scale: 0.1,  unit: 'V' },
  { key: 'mppt2Current',   group: 'Messwerte',           label: 'PV2 Strom',                     fc: 4, addr: 5335,  type: 'u16', scale: 0.1,  unit: 'A' },
  { key: 'mppt3Voltage',   group: 'Messwerte',           label: 'PV3 Spannung',                  fc: 4, addr: 5336,  type: 'u16', scale: 0.1,  unit: 'V' },
  { key: 'mppt3Current',   group: 'Messwerte',           label: 'PV3 Strom',                     fc: 4, addr: 5337,  type: 'u16', scale: 0.1,  unit: 'A' },
  { key: 'mppt4Voltage',   group: 'Messwerte',           label: 'PV4 Spannung',                  fc: 4, addr: 5338,  type: 'u16', scale: 0.1,  unit: 'V' },
  { key: 'mppt4Current',   group: 'Messwerte',           label: 'PV4 Strom',                     fc: 4, addr: 5339,  type: 'u16', scale: 0.1,  unit: 'A' },
  { key: 'mppt1Power',     group: 'Messwerte',           label: 'MPPT1 DC-Leistung',             fc: 4, addr: 5643,  type: 'u32', scale: 1,    unit: 'W' },
  { key: 'mppt2Power',     group: 'Messwerte',           label: 'MPPT2 DC-Leistung',             fc: 4, addr: 5645,  type: 'u32', scale: 1,    unit: 'W' },
  { key: 'mppt3Power',     group: 'Messwerte',           label: 'MPPT3 DC-Leistung',             fc: 4, addr: 5647,  type: 'u32', scale: 1,    unit: 'W' },
  { key: 'mppt4Power',     group: 'Messwerte',           label: 'MPPT4 DC-Leistung',             fc: 4, addr: 5649,  type: 'u32', scale: 1,    unit: 'W' },
  { key: 'inverterTemp',   group: 'Messwerte',           label: 'Gerätetemperatur',              fc: 4, addr: 5244,  type: 's16', scale: 0.1,  unit: '°C' },
  { key: 'gridVoltage1',   group: 'Messwerte',           label: 'Netzspannung',                  fc: 4, addr: 5246,  type: 'u16', scale: 0.1,  unit: 'V' },
  { key: 'phaseCurrent1',  group: 'Messwerte',           label: 'Netzstrom',                     fc: 4, addr: 5249,  type: 'u16', scale: 0.1,  unit: 'A' },
  { key: 'gridFrequency',  group: 'Messwerte',           label: 'Netzfrequenz (0,01 Hz)',        fc: 4, addr: 5241,  type: 'u16', scale: 0.01, unit: 'Hz' },
  { key: 'ratedPower',     group: 'Messwerte',           label: 'Nennleistung (0,01 kW)',        fc: 4, addr: 5622,  type: 'u16', scale: 0.01, unit: 'kW' },
  { key: 'yieldTotal',     group: 'Zähler',              label: 'Ertrag gesamt (0,1 kWh)',       fc: 4, addr: 5227,  type: 'u32', scale: 0.1,  unit: 'kWh' }
];

const TYPES = {
  hybrid: { label: 'Hybrid mit Batterie', map: HYBRID },
  string: { label: 'Stringwechselrichter', map: STRING },
  micro:  { label: 'Mikrowechselrichter', map: MICRO }
};

/* Modelle für das Auswahlmenü. Alle Sungrow-Hybride (SH) nutzen die Registerfamilie 13xxx/33xxx, alle Sungrow-Strings
   (SG) die Familie 5xxx; die Modelle unterscheiden sich für die Steuerung vor allem in Nennleistung und Phasenzahl.
   overrides: abweichende Adressen je Modell (Schlüssel → Adresse), bleiben leer, solange nichts anderes belegt ist.
   Die Mikrowechselrichter der S-Serie haben eine eigene Karte (MICRO) und zählen wie Strings zu Solar und Haus. */
const MODELS = [
  { group: 'Hybrid dreiphasig SH-RT', items: [['sh5.0rt', 'SH5.0RT', 5000], ['sh6.0rt', 'SH6.0RT', 6000], ['sh8.0rt', 'SH8.0RT', 8000], ['sh10rt', 'SH10RT', 10000]], type: 'hybrid', phases: 3 },
  { group: 'Hybrid dreiphasig SH-T (ab 2023)', items: [['sh5t', 'SH5T', 5000], ['sh6t', 'SH6T', 6000], ['sh8t', 'SH8T', 8000], ['sh10t', 'SH10T', 10000], ['sh15t', 'SH15T', 15000], ['sh20t', 'SH20T', 20000], ['sh25t', 'SH25T', 25000]], type: 'hybrid', phases: 3 },
  { group: 'Hybrid einphasig SH-RS', items: [['sh3.0rs', 'SH3.0RS', 3000], ['sh3.6rs', 'SH3.6RS', 3680], ['sh4.0rs', 'SH4.0RS', 4000], ['sh5.0rs', 'SH5.0RS', 5000], ['sh6.0rs', 'SH6.0RS', 6000]], type: 'hybrid', phases: 1 },
  { group: 'String dreiphasig SG-RT', items: [['sg3.0rt', 'SG3.0RT', 3000], ['sg4.0rt', 'SG4.0RT', 4000], ['sg5.0rt', 'SG5.0RT', 5000], ['sg6.0rt', 'SG6.0RT', 6000], ['sg7.0rt', 'SG7.0RT', 7000], ['sg8.0rt', 'SG8.0RT', 8000], ['sg10rt', 'SG10RT', 10000], ['sg12rt', 'SG12RT', 12000], ['sg15rt', 'SG15RT', 15000], ['sg17rt', 'SG17RT', 17000], ['sg20rt', 'SG20RT', 20000]], type: 'string', phases: 3 },
  { group: 'String einphasig SG-RS', items: [['sg2.0rs', 'SG2.0RS', 2000], ['sg2.5rs', 'SG2.5RS', 2500], ['sg3.0rs', 'SG3.0RS', 3000], ['sg3.6rs', 'SG3.6RS', 3680], ['sg4.0rs', 'SG4.0RS', 4000], ['sg5.0rs', 'SG5.0RS', 5000], ['sg6.0rs', 'SG6.0RS', 6000]], type: 'string', phases: 1 },
  { group: 'String gewerblich SG-CX', items: [['sg33cx', 'SG33CX', 33000], ['sg40cx', 'SG40CX', 40000], ['sg50cx', 'SG50CX', 50000], ['sg110cx', 'SG110CX', 110000]], type: 'string', phases: 3 },
  { group: 'Mikrowechselrichter S-Serie', items: [['s1600s', 'S1600S', 1600], ['other-micro', 'Anderer Mikrowechselrichter der S-Serie (Register selbst prüfen)', 2000]], type: 'micro', phases: 1 },
  { group: 'Sonstige', items: [['other-hybrid', 'Anderer Hybrid (Register selbst prüfen)', 10000], ['other-string', 'Anderer Stringwechselrichter (Register selbst prüfen)', 10000]], type: null, phases: 3 }
];
const MODEL_INDEX = {};
MODELS.forEach(function (g) { g.items.forEach(function (it) { MODEL_INDEX[it[0]] = { id: it[0], label: it[1], ratedPower: it[2], type: g.type || (it[0].indexOf('hybrid') >= 0 ? 'hybrid' : 'string'), phases: g.phases, group: g.group, overrides: {} }; }); });
function modelOf(inv) { const m = inv && MODEL_INDEX[inv.model]; if (m) return m; return inv && inv.type === 'string' ? MODEL_INDEX['sg8.0rt'] : inv && inv.type === 'micro' ? MODEL_INDEX['s1600s'] : MODEL_INDEX['sh10rt']; }
function modelList() { return MODELS.map(function (g) { return { group: g.group, type: g.type, phases: g.phases, items: g.items.map(function (it) { return { id: it[0], label: it[1], ratedPower: it[2], type: MODEL_INDEX[it[0]].type }; }) }; }); }

function words(type) { return type === 'u32' || type === 's32' ? 2 : 1; }

/* Karte eines Wechselrichters: Standardkarte seines Typs, Adressen aus inv.registers überschrieben */
function mapFor(inv) {
  const t = TYPES[inv && inv.type] || TYPES.hybrid, over = (inv && inv.registers) || {}, mo = modelOf(inv).overrides;
  return t.map.map(function (e) {
    const base = Number.isInteger(mo[e.key]) ? mo[e.key] : e.addr, a = over[e.key];
    return Object.assign({}, e, { addr: Number.isInteger(a) && a >= 0 && a <= 65535 ? a : base, words: words(e.type), custom: Number.isInteger(a) && a !== base, modelAddr: base });
  });
}
function addressOf(inv, key) { const e = mapFor(inv).filter(function (x) { return x.key === key; })[0]; return e ? e.addr : null; }

/* Leseplan: Einträge gleicher Funktion zu Blöcken zusammenfassen (kleine Lücken werden mitgelesen, höchstens 100 Register je Block) */
function makePlan(entries) {
  const blocks = [];
  [3, 4].forEach(function (fc) {
    const list = entries.filter(function (e) { return e.fc === fc; }).sort(function (x, y) { return x.addr - y.addr; });
    let cur = null;
    list.forEach(function (e) {
      const end = e.addr + e.words;
      if (cur && e.addr - cur.end <= 6 && Math.max(cur.end, end) - cur.start <= 100) { cur.end = Math.max(cur.end, end); cur.entries.push(e); }
      else { cur = { fc: fc, start: e.addr, end: end, entries: [e] }; blocks.push(cur); }
    });
  });
  return blocks;
}

function decodeEntry(e, w, offset) {
  const a = w[offset], b = w[offset + 1];
  if (a === undefined || (e.words === 2 && b === undefined)) return null;
  if (e.type === 'u16') return a;
  if (e.type === 's16') return a > 0x7fff ? a - 0x10000 : a;
  const v = a + b * 65536;
  if (e.type === 'u32') return v;
  return v > 0x7fffffff ? v - 0x100000000 : v;
}

/* Liest einen Plan über einen Modbus-Client (Objekt mit read(unit, fc, addr, count) -> Promise<Wörter>).
   Liefert { values: {key: Rohwert}, errors: {key: Text} }. Kennt die Firmware ein Register nicht (Ausnahme 2 oder 3),
   wird der betroffene Block dauerhaft in Einzelregister zerlegt, damit ein falsch gesetzter Eintrag nicht die Nachbarn
   mitreißt. Bei Verbindungsfehlern wird abgebrochen. */
function readPlan(client, unit, plan, pause) {
  const values = {}, errors = {};
  let i = 0, aborted = null;
  const wait = pause || function () { return Promise.resolve(); };
  const step = function () {
    if (i >= plan.length || aborted) return Promise.resolve();
    const blk = plan[i];
    return client.read(unit, blk.fc, blk.start, blk.end - blk.start).then(function (w) {
      blk.entries.forEach(function (e) {
        const v = decodeEntry(e, w, e.addr - blk.start);
        if (v === null) errors[e.key] = 'Antwort zu kurz'; else values[e.key] = v;
      });
      i++;
    }, function (err) {
      const m = /Modbus-Ausnahme (\d+)/.exec(err.message || '');
      if (m && (m[1] === '2' || m[1] === '3')) {
        if (blk.entries.length > 1) {
          const singles = blk.entries.map(function (e) { return { fc: blk.fc, start: e.addr, end: e.addr + e.words, entries: [e] }; });
          plan.splice.apply(plan, [i, 1].concat(singles));
          return;
        }
        errors[blk.entries[0].key] = err.message; i++;
        return;
      }
      if (m) { blk.entries.forEach(function (e) { errors[e.key] = err.message; }); i++; return; }
      aborted = err.message;
      plan.slice(i).forEach(function (b) { b.entries.forEach(function (e) { errors[e.key] = err.message; }); });
    }).then(wait).then(step);
  };
  return step().then(function () { return { values: values, errors: errors, aborted: aborted }; });
}

/* Hauptwechselrichter (aktiver Hybrid) und Stringwechselrichter aus einer Konfiguration, auch aus dem alten Format */
function normalizeInverters(c) {
  if (Array.isArray(c.inverters) && c.inverters.length) return c.inverters;
  const out = [];
  if (c.inverter && c.inverter.host) out.push({ name: c.inverter.name || 'Hybrid', enabled: true, type: 'hybrid', host: c.inverter.host, port: c.inverter.port || 502, unitId: c.inverter.unitId || 1, registers: {} });
  if (c.inverter2 && c.inverter2.host) out.push({ name: c.inverter2.name || 'Stringwechselrichter', enabled: c.inverter2.enabled !== false, type: 'string', host: c.inverter2.host, port: c.inverter2.port || 502, unitId: c.inverter2.unitId || 1, addToHouseLoad: c.inverter2.addToHouseLoad !== false, registers: {} });
  return out;
}
function mainInverter(c) { return normalizeInverters(c).filter(function (i) { return i.type === 'hybrid' && i.enabled !== false; })[0] || null; }

/* Für die Konsolenwerkzeuge: Hauptwechselrichter aus config.json im Programmordner */
function cliTarget(dir) {
  let c = {};
  const confDir = process.env.SUNGROW_CONFIG_DIR || dir;
  try { c = JSON.parse(require('fs').readFileSync(require('path').join(confDir, 'config.json'), 'utf8')); } catch (e) { return null; }
  const m = mainInverter(c); if (!m || !m.host) return null;
  return { host: m.host, port: m.port || 502, unitId: m.unitId === undefined ? 1 : m.unitId, name: m.name || 'Hybrid', ratedPower: m.ratedPower || 10600,
    webPort: (c.http && c.http.port) || 8787, A: function (key) { return addressOf(m, key); } };
}

module.exports = { cliTarget: cliTarget, HYBRID: HYBRID, STRING: STRING, MICRO: MICRO, TYPES: TYPES, MODELS: MODELS, modelOf: modelOf, modelList: modelList, mapFor: mapFor, addressOf: addressOf, makePlan: makePlan, readPlan: readPlan, decodeEntry: decodeEntry,
  normalizeInverters: normalizeInverters, mainInverter: mainInverter };
