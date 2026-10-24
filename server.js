'use strict';
/*
 * Sungrow Steuerung – (C) by Elric M.
 * Nur für die private Nutzung zu Test- und Lernzwecken. Kommerzielle Verwendung jeder Art, die Verwendung im
 * Geschäftsbetrieb und der Weiterverkauf sind untersagt. Benutzung auf eigene Gefahr, ohne Gewährleistung oder Garantie.
 * Einzelheiten: LICENSE und HANDBUCH.md.
 */
/*
 * Sungrow Steuerung – Messbetrieb und Webserver.
 * Liest Sungrow-Hybridwechselrichter (SH-RT) mit SBR-Batterie und beliebig viele Stringwechselrichter (SG-RT) per Modbus TCP,
 * die Zellwerte der Batterie über die Web-Schnittstelle des WiNet-S, und stellt ein Web-Dashboard bereit.
 *
 * Keine npm-Abhängigkeiten: nur Node-Bordmittel. Der Messbetrieb in dieser Datei liest ausschließlich (FC03/FC04).
 * Geschrieben wird nur im Steuerteil control.js (Seiten Einstellungen und Matching) auf Knopfdruck oder im gestarteten Ablauf,
 * und die Konfiguration nur über die Seite Anlage (setup.js).
 */
const net = require('net');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const R = require('./registers');

const ROOT = __dirname;
/* Datenordner: config.json und data/ liegen im Programmordner, oder in SUNGROW_CONFIG_DIR (z. B. ein Docker-Volume) */
const CONF_DIR = process.env.SUNGROW_CONFIG_DIR ? path.resolve(process.env.SUNGROW_CONFIG_DIR) : ROOT;
const DATA_DIR = path.join(CONF_DIR, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_FILE = path.join(CONF_DIR, 'config.json');
const BUILD = 'd807f67b035c6060d7409de0a3ac2742b9cff20cce35cc3b669cb762621207ad';   // Kennung dieses Standes, Kopfzeile X-Build

/* ---------------------------------------------------------------- Konfiguration
   Eingerichtet wird über die Seite „Anlage“ im Browser. Fehlt config.json, startet das Programm im Einrichtungsmodus. */

const DEFAULTS = {
  plantName: 'Meine Anlage',
  http: { port: parseInt(process.env.PORT, 10) || 8787 },
  inverters: [],
  battery: { enabled: false, host: null, port: 502, unitId: 200, cellBlockAddress: 10756, cellBlockCount: 32 },
  winet: { enabled: true, host: null, port: 443, username: '', password: '', paramAddress: 10756, paramCount: 30, paramType: 0, intervalSeconds: 30 },
  pollSeconds: 10,
  storeSeconds: 30,
  requestGapMs: 200,
  timeoutMs: 4000,
  historyDays: 7,
  retentionDays: 120,
  moduleCount: 8,
  topModuleIndex: 8,
  moduleNotes: {},
  meters: [],
  flow: { house: 'auto', heatpump: 'auto', car: 'auto' },   // Quellen des Energieflusses: auto | inverter | none | register | meter:<Name>
  heatpump: { enabled: false, name: 'Wärmepumpe', model: 'weishaupt', host: '', port: 502, unitId: 1, framing: 'rtu', pollSeconds: 30, writeEnabled: false, shift: { min: -3, max: 5 }, registers: {} },
  prices: { exchange: 'none', fixedCt: 18, vatPercent: 19, feedInCt: 8, fallbackCt: 30, zone: 'DE-LU', url: '' },
  forecast: { provider: 'openmeteo', lat: null, lon: null, planes: [], performanceRatio: 0.85, urlWeather: '', urlSolar: '' },
  planner: { mode: 'off', horizonHours: 36, capacityKwh: 0, minSoc: 10, maxSoc: 100, chargeW: 5000, dischargeW: 5000, pvChargeW: 10000, efficiency: 0.88, marginCt: 2, baseLoadW: 400, tickSeconds: 60,
    heat: { enabled: false, limitTemp: 15, wattsPerKelvin: 100, kwPerShiftK: 0.15, storeHours: 4, shiftUp: 3, shiftDown: -2, surplusW: 1500, cheapPct: 25, expensivePct: 25 } }
};

function merge(base, over) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  Object.keys(over || {}).forEach(function (k) {
    const v = over[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) out[k] = merge(base[k], v);
    else out[k] = v;
  });
  return out;
}

let cfg = merge(DEFAULTS, {});
if (fs.existsSync(CONFIG_FILE)) {
  try { cfg = merge(DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); }
  catch (e) { console.log('config.json nicht lesbar (' + e.message + '). Bitte auf der Seite Anlage neu speichern.'); }
}
cfg.inverters = R.normalizeInverters(cfg);                 // versteht auch das alte Format mit inverter und inverter2
cfg.inverter = R.mainInverter(cfg) || { name: 'Hybrid', type: 'hybrid', enabled: true, host: '', port: 502, unitId: 1, registers: {} };
cfg.inverter.port = cfg.inverter.port || 502;
cfg.inverter.unitId = cfg.inverter.unitId === undefined ? 1 : cfg.inverter.unitId;
cfg.inverter.ratedPower = cfg.inverter.ratedPower || 10600;
cfg.strings = cfg.inverters.filter(function (i) { return (i.type === 'string' || i.type === 'micro') && i.enabled !== false && i.host; });   // Mikrowechselrichter zählen wie Strings
const CONFIGURED = !!cfg.inverter.host;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------------------------------------------------------------- Modbus TCP */

const ModbusTcp = require('./modbus-client');     // Modbus TCP und RTU über TCP, gemeinsam mit der Wärmepumpe

/* ---------------------------------------------------------------- Dekodierung */

function s16(v) { return v > 0x7fff ? v - 0x10000 : v; }
function u32(w, i) { return w[i] + w[i + 1] * 65536; }             // Sungrow: niederwertiges Wort zuerst
function s32(w, i) { const v = u32(w, i); return v > 0x7fffffff ? v - 0x100000000 : v; }
function r(v, digits) { const f = Math.pow(10, digits); return Math.round(v * f) / f; }
function valid(v) { return v !== undefined && v !== 0xffff && v !== 0; }

const SYSTEM_STATES = {
  0x0002: 'Gestoppt', 0x0008: 'Standby', 0x0010: 'Start-Standby', 0x0020: 'Hochfahren',
  0x0040: 'In Betrieb', 0x0041: 'Netzersatzbetrieb', 0x0100: 'Störung', 0x0200: 'Update läuft',
  0x0400: 'Wartungsbetrieb', 0x0800: 'Zwangsmodus', 0x1000: 'Inselbetrieb', 0x1111: 'Nicht initialisiert',
  0x1200: 'Hochfahren', 0x1300: 'Herunterfahren', 0x1400: 'Standby', 0x1500: 'Not-Aus',
  0x1600: 'Hochfahren', 0x2501: 'Neustart', 0x4000: 'Externes EMS', 0x4001: 'Notladung'
};
const EMS_MODES = { 0: 'Eigenverbrauch', 2: 'Zwangsmodus', 3: 'Externes EMS', 4: 'VPP' };
const FORCED_CMDS = { 0xaa: 'Laden', 0xbb: 'Entladen', 0xcc: 'Stopp' };

/* Manche Firmwarestände liefern im Zustandsregister 0. Dann beschreiben die Betriebsbits, was läuft. */
function describeRunning(running, code) {
  const parts = [];
  if (running & 0x01) parts.push('Solar erzeugt');
  if (running & 0x02) parts.push('Batterie lädt');
  if (running & 0x04) parts.push('Batterie entlädt');
  if (running & 0x10) parts.push('speist ein');
  if (running & 0x20) parts.push('bezieht aus dem Netz');
  if (parts.length) return parts.join(', ');
  return code ? 'Zustand 0x' + code.toString(16) : 'In Betrieb';
}

function decodeInverter(v) {
  const g = function (k) { return v[k] === undefined || v[k] === null ? 0 : v[k]; };
  const running = g('runningBits');
  const charging = !!(running & 0x02);
  const discharging = !!(running & 0x04);
  const magP = Math.abs(g('battPower'));
  const magA = Math.abs(g('battCurrent')) * 0.1;
  /* Richtung der Batterie. Die Leistung kommt bei manchen Firmwareständen ohne Vorzeichen, und die Betriebsbits hinken im
     Zwangsmodus hinterher oder fehlen. Deshalb in dieser Reihenfolge:
       1. Zwangsmodus mit Befehl Laden oder Entladen: die Richtung ist vorgegeben.
       2. Energiebilanz des Wechselrichters: Solar (DC) minus AC-Abgabe. Bleibt davon etwas übrig, fließt es in die Batterie,
          fehlt etwas, kommt es aus der Batterie. Widerspricht die Bilanz deutlich den Bits, gilt die Bilanz.
       3. Sonst die Betriebsbits. */
  const bits = charging && !discharging ? 1 : discharging && !charging ? -1 : 0;
  const balance = g('pvPower') - g('acPower');
  let sign;
  if (v.emsMode === 2 && v.forcedCmd === 0xaa) sign = 1;
  else if (v.emsMode === 2 && v.forcedCmd === 0xbb) sign = -1;
  else if (Math.abs(balance) > 400) sign = balance > 0 ? 1 : -1;
  else sign = bits || (balance > 0 ? 1 : balance < 0 ? -1 : 0);
  if (magP < 5) sign = 0;
  const f = g('gridFrequency');
  const cap = g('battCapacity') * 0.01;
  return {
    systemStateCode: g('systemState'),
    systemState: SYSTEM_STATES[g('systemState')] || describeRunning(running, g('systemState')),
    flags: { pv: !!(running & 0x01), charging: charging, discharging: discharging, exporting: !!(running & 0x10), importing: !!(running & 0x20) },
    pvPower: g('pvPower'),
    mppt: [ { v: r(g('mppt1Voltage') * 0.1, 1), a: r(g('mppt1Current') * 0.1, 1) }, { v: r(g('mppt2Voltage') * 0.1, 1), a: r(g('mppt2Current') * 0.1, 1) } ],
    inverterTemp: r(g('inverterTemp') * 0.1, 1),
    phaseVoltage: [r(g('gridVoltage1') * 0.1, 1), r(g('gridVoltage2') * 0.1, 1), r(g('gridVoltage3') * 0.1, 1)],
    phaseCurrent: [r(g('phaseCurrent1') * 0.1, 1), r(g('phaseCurrent2') * 0.1, 1), r(g('phaseCurrent3') * 0.1, 1)],
    frequency: r(f > 1000 ? f / 100 : f / 10, 2),
    loadPower: g('loadPower'),
    gridPower: -g('exportPower'),            // positiv = Netzbezug, negativ = Einspeisung
    acPower: g('acPower'),
    battery: {
      voltage: r(g('battVoltage') * 0.1, 1),
      current: r(sign * magA, 1),            // positiv = Laden
      power: sign * magP,                    // positiv = Laden
      soc: r(g('soc') * 0.1, 1),
      soh: r(g('soh') * 0.1, 1),
      temp: r(g('battTemp') * 0.1, 1),
      capacityKwh: cap >= 3 && cap <= 200 ? r(cap, 1) : null
    },
    today: {
      pv: r(g('pvToday') * 0.1, 1), import: r(g('importToday') * 0.1, 1), export: r(g('exportToday') * 0.1, 1),
      battCharge: r(g('battChargeToday') * 0.1, 1), battDischarge: r(g('battDischargeToday') * 0.1, 1), selfConsumption: r(g('selfConsumptionToday') * 0.1, 1)
    },
    total: {
      pv: r(g('pvTotal') * 0.1, 1), import: r(g('importTotal') * 0.1, 1), export: r(g('exportTotal') * 0.1, 1),
      battCharge: r(g('battChargeTotal') * 0.1, 1), battDischarge: r(g('battDischargeTotal') * 0.1, 1)
    }
  };
}

function decodeStringInverter(v, micro) {
  const g = function (k) { return v[k] === undefined || v[k] === null ? 0 : v[k]; };
  const f = g('gridFrequency');
  if (micro) return {                      // S-Serie: 4 PV-Eingänge, einphasig, Gesamtzähler in 0,1 kWh, kein Tagesertrag-Register
    acPower: g('acPower'), dcPower: g('dcPower'), running: g('runningState'),
    mppt: [1, 2, 3, 4].map(function (n) { return { v: r(g('mppt' + n + 'Voltage') * 0.1, 1), a: r(g('mppt' + n + 'Current') * 0.1, 1), w: g('mppt' + n + 'Power') }; }),
    inverterTemp: r(g('inverterTemp') * 0.1, 1), phaseVoltage: [r(g('gridVoltage1') * 0.1, 1), 0, 0], phaseCurrent: [r(g('phaseCurrent1') * 0.1, 1), 0, 0],
    frequency: r(f / 100, 2), ratedPower: r(g('ratedPower') * 10, 0), todayKwh: null, totalKwh: r(g('yieldTotal') * 0.1, 1)
  };
  return {
    acPower: g('acPower'),
    dcPower: g('dcPower'),
    mppt: [ { v: r(g('mppt1Voltage') * 0.1, 1), a: r(g('mppt1Current') * 0.1, 1) }, { v: r(g('mppt2Voltage') * 0.1, 1), a: r(g('mppt2Current') * 0.1, 1) } ],
    inverterTemp: r(g('inverterTemp') * 0.1, 1),
    phaseVoltage: [r(g('gridVoltage1') * 0.1, 1), r(g('gridVoltage2') * 0.1, 1), r(g('gridVoltage3') * 0.1, 1)],
    phaseCurrent: [r(g('phaseCurrent1') * 0.1, 1), r(g('phaseCurrent2') * 0.1, 1), r(g('phaseCurrent3') * 0.1, 1)],
    frequency: r(f > 1000 ? f / 100 : f / 10, 2),
    todayKwh: r(g('yieldToday') * 0.1, 1),
    totalKwh: g('yieldTotal')
  };
}

function decodeSettings(v) {
  const out = {}, has = function (k) { return v[k] !== undefined && v[k] !== null; };
  if (has('emsMode')) {
    out.emsMode = EMS_MODES[v.emsMode] !== undefined ? EMS_MODES[v.emsMode] : ('Modus ' + v.emsMode);
    if (has('forcedCmd')) out.forcedCommand = FORCED_CMDS[v.forcedCmd] || ('0x' + v.forcedCmd.toString(16));
    if (has('forcedPower')) out.forcedPowerW = v.forcedPower;
  }
  if (has('maxSoc')) out.maxSoc = r(v.maxSoc * 0.1, 1);
  if (has('minSoc')) out.minSoc = r(v.minSoc * 0.1, 1);
  if (has('maxCharge') && has('maxDischarge')) { out.maxChargeW = v.maxCharge * 10; out.maxDischargeW = v.maxDischarge * 10; }
  if (has('backupReserve')) out.backupReserve = v.backupReserve;      // reservierter SOC für Notstrom, in Prozent
  if (has('tcEnable') && has('tc1StartH') && has('tc1EndH') && has('tc1Target')) {
    // Zeitfenster-Zwangsladung: 0xAA = ein, 0x55 = aus, dazu Fenster 1 und Ziel-SOC
    const p2 = function (n) { return n < 10 ? '0' + n : '' + n; };
    out.timedCharge = { enabled: v.tcEnable === 0xaa, from: p2(v.tc1StartH) + ':' + p2(v.tc1StartM || 0), to: p2(v.tc1EndH) + ':' + p2(v.tc1EndM || 0), targetSoc: v.tc1Target };
  }
  return out;
}

function pos(w) { return valid(w) ? { module: w >> 8, cell: w & 0xff } : null; }

function decodeCells(w) {
  // Block ab Doku-Register 10757 (Adresse 10756). Aufbau an einem realen SBR-Turm verifiziert:
  // max. Zelle, Position, min. Zelle, Position, max. Temp, Position, min. Temp, Position,
  // 8x Modul-Maximum, 8x Modul-Minimum, danach vermutlich Modulspannungen in Volt.
  const modules = [];
  for (let i = 0; i < cfg.moduleCount; i++) {
    const mx = w[8 + i], mn = w[16 + i], mv = w[24 + i];
    modules.push({
      index: i + 1,
      max: valid(mx) ? r(mx / 10000, 4) : null,
      min: valid(mn) ? r(mn / 10000, 4) : null,
      voltage: valid(mv) && mv < 100 ? mv : null
    });
  }
  const cellMax = valid(w[0]) ? r(w[0] / 10000, 4) : null;
  const cellMin = valid(w[2]) ? r(w[2] / 10000, 4) : null;
  return {
    cellMax: cellMax, cellMaxPos: pos(w[1]),
    cellMin: cellMin, cellMinPos: pos(w[3]),
    spreadMv: cellMax !== null && cellMin !== null ? r((cellMax - cellMin) * 1000, 1) : null,
    tempMax: valid(w[4]) ? r(s16(w[4]) * 0.1, 1) : null, tempMaxPos: pos(w[5]),
    tempMin: valid(w[6]) ? r(s16(w[6]) * 0.1, 1) : null, tempMinPos: pos(w[7]),
    modules: modules
  };
}

/* ---------------------------------------------------------------- WiNet-S: Zellwerte über die Web-Schnittstelle
   Der WiNet-S reicht die Batterie (Unit 200) nicht über Port 502 durch. Seine Weboberfläche liest sie aber per
   GET /device/getParam. Den dafür nötigen Token gibt es über den WebSocket /ws/home/overview (connect, login).
   Auch hier wird nur gelesen (type=3 = Zurücklesen). */

function WsClient(host, port, wsPath, timeoutMs) {
  this.host = host; this.port = port; this.path = wsPath; this.timeoutMs = timeoutMs;
  this.sock = null; this.buf = Buffer.alloc(0); this.parts = []; this.waiters = []; this.onclose = null;
}

WsClient.prototype.open = function () {
  const self = this;
  return new Promise(function (resolve, reject) {
    const req = https.request({
      host: self.host, port: self.port, path: self.path, method: 'GET', rejectUnauthorized: false,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), Origin: 'https://' + self.host }
    });
    const timer = setTimeout(function () { req.destroy(new Error('WiNet-S antwortet nicht auf den WebSocket-Aufbau')); }, self.timeoutMs);
    req.on('upgrade', function (res, socket, head) {
      clearTimeout(timer);
      self.sock = socket;
      socket.on('data', function (d) { self._onData(d); });
      socket.on('close', function () { self._closed('WebSocket vom WiNet-S geschlossen'); });
      socket.on('error', function (e) { self._closed('WebSocket-Fehler: ' + e.message); });
      if (head && head.length) self._onData(head);
      resolve();
    });
    req.on('response', function (res) { clearTimeout(timer); reject(new Error('WiNet-S lehnt den WebSocket ab (HTTP ' + res.statusCode + ')')); });
    req.on('error', function (e) { clearTimeout(timer); reject(e); });
    req.end();
  });
};

WsClient.prototype._closed = function (msg) {
  if (!this.sock) return;
  this.sock = null;
  this.waiters.splice(0).forEach(function (w) { clearTimeout(w.timer); w.reject(new Error(msg)); });
  if (this.onclose) this.onclose(msg);
};

WsClient.prototype._onData = function (d) {
  this.buf = Buffer.concat([this.buf, d]);
  for (;;) {
    if (this.buf.length < 2) return;
    const b0 = this.buf[0], b1 = this.buf[1];
    let len = b1 & 0x7f, off = 2;
    if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (this.buf.length < 10) return; len = this.buf.readUInt32BE(2) * 4294967296 + this.buf.readUInt32BE(6); off = 10; }
    const masked = !!(b1 & 0x80);
    if (masked) off += 4;
    if (this.buf.length < off + len) return;
    let payload = this.buf.slice(off, off + len);
    if (masked) { const k = this.buf.slice(off - 4, off); payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= k[i % 4]; }
    this.buf = this.buf.slice(off + len);
    const op = b0 & 0x0f, fin = !!(b0 & 0x80);
    if (op === 8) { const s = this.sock; this._closed('WebSocket vom WiNet-S beendet'); if (s) s.destroy(); return; }
    if (op === 9) { this._frame(10, payload); continue; }
    if (op === 10) continue;
    this.parts.push(payload);
    if (fin) { const text = Buffer.concat(this.parts).toString('utf8'); this.parts = []; this._message(text); }
  }
};

WsClient.prototype._message = function (text) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) { return; }
  for (let i = 0; i < this.waiters.length; i++) {
    if (this.waiters[i].match(obj)) { const w = this.waiters.splice(i, 1)[0]; clearTimeout(w.timer); w.resolve(obj); return; }
  }
};

WsClient.prototype._frame = function (opcode, payload) {
  if (!this.sock) return;
  const len = payload.length, mask = crypto.randomBytes(4);
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = 0x80 | len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 0x80 | 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
  head[0] = 0x80 | opcode;
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
  this.sock.write(Buffer.concat([head, mask, body]));
};

WsClient.prototype.send = function (obj) { this._frame(1, Buffer.from(JSON.stringify(obj), 'utf8')); };

WsClient.prototype.ask = function (obj, match, what) {
  const self = this;
  return new Promise(function (resolve, reject) {
    if (!self.sock) return reject(new Error('WebSocket nicht verbunden'));
    const w = { match: match, resolve: resolve, reject: reject };
    w.timer = setTimeout(function () {
      const i = self.waiters.indexOf(w); if (i >= 0) self.waiters.splice(i, 1);
      reject(new Error('WiNet-S antwortet nicht auf "' + what + '"'));
    }, self.timeoutMs);
    self.waiters.push(w);
    self.send(obj);
  });
};

WsClient.prototype.close = function () { const s = this.sock; this.sock = null; this.waiters = []; if (s) s.destroy(); };

const winet = { ws: null, token: null, dev: null, paramType: null, pingTimer: null, cells: null, cellsAt: 0 };

function winetHost() { return cfg.winet.host || cfg.inverter.host; }

function winetResult(msg, what) {
  if (msg && msg.result_code === 1) return msg.result_data || {};
  const code = msg ? msg.result_code : '?', text = msg && msg.result_msg ? msg.result_msg : '';
  throw new Error(what + ' abgelehnt (Code ' + code + (text ? ', ' + text : '') + ')');
}

/* Anmeldung an der Weboberfläche eines WiNet-S und Suche der Batterie in seiner Geräteliste.
   o: { host, port, username, password, devId?, devType?, devCode? } -> { ws, token, dev } */
function winetOpen(o) {
  const ws = new WsClient(o.host, o.port, '/ws/home/overview', 8000), sess = { ws: ws, token: null, dev: null };
  const hasData = function (m) { return m && (m.result_data !== undefined || m.result_code !== 1); };
  if (!o.username || !o.password) return Promise.reject(new Error('Benutzer oder Passwort des WiNet-S fehlen (Seite Anlage)'));
  return ws.open().then(function () {
    return ws.ask({ lang: 'en_us', token: '', service: 'connect' }, function (m) { return hasData(m) && (!m.result_data || m.result_data.token !== undefined || m.result_data.service === 'connect'); }, 'connect');
  }).then(function (m) {
    sess.token = winetResult(m, 'Verbindungsaufbau').token;
    if (!sess.token) throw new Error('WiNet-S hat keinen Token geliefert');
    return ws.ask({ lang: 'en_us', token: sess.token, service: 'login', passwd: o.password, username: o.username },
      function (m2) { return hasData(m2) && (!m2.result_data || m2.result_data.service === 'login' || m2.result_data.token !== undefined); }, 'login');
  }).then(function (m) {
    if (m) { const d = winetResult(m, 'Anmeldung (Benutzer oder Passwort prüfen)'); if (d.token) sess.token = d.token; }
    if (o.devId && o.devType && o.devCode) return { dev_id: o.devId, dev_type: o.devType, dev_code: o.devCode };
    return ws.ask({ lang: 'en_us', token: sess.token, service: 'devicelist', type: '0', is_check_token: '0' },
      function (m3) { return m3 && (m3.result_code !== 1 || (m3.result_data && m3.result_data.service === 'devicelist')); }, 'devicelist')
      .then(function (m3) {
        const list = winetResult(m3, 'Geräteliste').list || [];
        const batt = list.filter(function (d) { return /^SBR/i.test(d.dev_model || '') || String(d.phys_addr) === String(cfg.battery.unitId); })[0];
        if (!batt) throw new Error('keine SBR-Batterie in der Geräteliste des WiNet-S gefunden');
        return batt;
      });
  }).then(function (dev) { sess.dev = dev; return sess; })
    .catch(function (e) { ws.close(); throw e; });
}

function winetLogin() {
  const w = cfg.winet;
  return winetOpen({ host: winetHost(), port: w.port, username: w.username, password: w.password, devId: w.devId, devType: w.devType, devCode: w.devCode }).then(function (sess) {
    winet.dev = sess.dev; winet.token = sess.token; winet.ws = sess.ws;
    sess.ws.onclose = function () { winetReset(); };
    winet.pingTimer = setInterval(function () {
      if (sess.ws.sock) sess.ws.send({ lang: 'en_us', service: 'ping', token: '', id: crypto.randomBytes(16).toString('hex') });
    }, 10000);
    console.log('WiNet-S angemeldet, Batterie: dev_id ' + sess.dev.dev_id + ', dev_type ' + sess.dev.dev_type + ', dev_code ' + sess.dev.dev_code);
  });
}

function winetReset() {
  if (winet.pingTimer) clearInterval(winet.pingTimer);
  if (winet.ws) winet.ws.close();
  winet.ws = null; winet.token = null; winet.pingTimer = null;
}

/* sess: { host, port, token, dev, paramAddress, paramCount } */
function winetGet(sess, paramType) {
  const d = sess.dev;
  const q = 'token=' + encodeURIComponent(sess.token) + '&lang=de_de&dev_id=' + d.dev_id + '&dev_type=' + d.dev_type + '&dev_code=' + d.dev_code +
    '&type=3&param_addr=' + sess.paramAddress + '&param_num=' + sess.paramCount + '&param_type=' + paramType;
  return new Promise(function (resolve, reject) {
    const req = https.request({ host: sess.host, port: sess.port, path: '/device/getParam?' + q, method: 'GET', rejectUnauthorized: false,
      headers: { Accept: 'application/json, text/plain, */*', Referer: 'https://' + sess.host + '/' } }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    });
    req.setTimeout(10000, function () { req.destroy(new Error('WiNet-S antwortet nicht auf getParam')); });
    req.on('error', reject);
    req.end();
  });
}

/* Antwort robust auswerten: die längste Folge von Hex-Bytes im Text ist der Registerinhalt. */
function parseParamWords(text) {
  const runs = text.match(/(?:\b[0-9A-Fa-f]{2}\b[ ,]*){8,}/g);
  if (!runs) {
    let info = '';
    try { const j = JSON.parse(text); info = ' (Code ' + j.result_code + (j.result_msg ? ', ' + j.result_msg : '') + ')'; } catch (e) { info = ' (' + text.slice(0, 80) + ')'; }
    throw new Error('getParam liefert keine Registerwerte' + info);
  }
  const bytes = runs.sort(function (x, y) { return y.length - x.length; })[0].match(/[0-9A-Fa-f]{2}/g).map(function (h) { return parseInt(h, 16); });
  const words = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) words.push(bytes[i] * 256 + bytes[i + 1]);
  return words;
}

function plausibleCells(words) { return words.length >= 24 && words[0] > 20000 && words[0] < 42000 && words[2] > 20000 && words[2] < 42000; }

function winetReadCells(sess, knownType, onType) {
  const pref = cfg.winet.paramType;
  const types = knownType !== null && knownType !== undefined ? [knownType] : [0, 1, 2, 3].sort(function (x, y) { return (y === pref) - (x === pref); });
  let lastErr = null;
  const tryNext = function (i) {
    if (i >= types.length) throw lastErr || new Error('kein passender Adresstyp gefunden');
    return winetGet(sess, types[i]).then(function (text) {
      let words = parseParamWords(text);
      // Die Oberfläche zählt Register ab 1: das erste gelieferte Wort liegt vor dem Zellblock
      if (words[0] === 0xffff || words[0] === 0) words = words.slice(1);
      if (!plausibleCells(words)) throw new Error('Adresstyp ' + types[i] + ' liefert keine plausiblen Zellspannungen');
      if (onType) onType(types[i]);
      while (words.length < 32) words.push(0xffff);
      return decodeCells(words);
    }).catch(function (e) { lastErr = e; return tryNext(i + 1); });
  };
  return tryNext(0);
}
function runningSession() { return { host: winetHost(), port: cfg.winet.port, token: winet.token, dev: winet.dev, paramAddress: cfg.winet.paramAddress, paramCount: cfg.winet.paramCount }; }

/* Für die Seite Anlage: mit den eingegebenen Daten anmelden, Zellwerte lesen, wieder abmelden.
   Der WiNet-S lässt meist nur eine Anmeldung zu: die laufende Abfrage meldet sich danach von selbst wieder an. */
function testWinet(o) {
  winetReset();
  return winetOpen(o).then(function (sess) {
    sess.host = o.host; sess.port = o.port; sess.paramAddress = o.paramAddress; sess.paramCount = o.paramCount;
    return winetReadCells(sess, null).then(function (c) {
      sess.ws.close();
      const mods = c.modules.filter(function (m) { return m.min !== null; }).length;
      return { ok: true, device: (sess.dev.dev_model || 'Batterie') + ' (dev_id ' + sess.dev.dev_id + ')', cellMin: c.cellMin, cellMax: c.cellMax, spreadMv: c.spreadMv, modulesSeen: mods };
    }, function (e) { sess.ws.close(); throw e; });
  });
}

let winetPauseUntil = 0;

function winetLoop() {
  // während eines Matching-Ablaufs die Zellwerte alle 10 Sekunden holen
  const again = function () { setTimeout(winetLoop, (control && control.isActive() ? Math.min(10, cfg.winet.intervalSeconds) : cfg.winet.intervalSeconds) * 1000); };
  // WiNet-S freigegeben: die eigene Web-Anmeldung loslassen, damit man sich im Browser am WiNet-S anmelden kann
  if (Date.now() < winetPauseUntil) {
    if (winet.ws) { winetReset(); console.log(new Date().toLocaleTimeString('de-DE') + ' WiNet-S freigegeben bis ' + new Date(winetPauseUntil).toLocaleTimeString('de-DE')); }
    state.batteryError = 'WiNet-S ist bis ' + new Date(winetPauseUntil).toLocaleTimeString('de-DE') + ' für deine Anmeldung im Browser freigegeben. Solange kommen keine Zellwerte.';
    return setTimeout(winetLoop, 5000);
  }
  const ready = winet.ws && winet.ws.sock ? Promise.resolve() : winetLogin();
  ready.then(function () { return winetReadCells(runningSession(), winet.paramType, function (t) { winet.paramType = t; }); }).then(function (cells) {
    if (state.batteryError || !winet.cells) console.log(new Date().toLocaleTimeString('de-DE') + ' Zellwerte werden gelesen (Spreizung ' + cells.spreadMv + ' mV)');
    winet.cells = cells; winet.cellsAt = Date.now(); state.batteryError = null;
    if (control) control.tick();
  }).catch(function (e) {
    if (state.batteryError !== e.message) console.log(new Date().toLocaleTimeString('de-DE') + ' Zellwerte: ' + e.message);
    state.batteryError = e.message;
    winetReset();
  }).then(again);
}

/* ---------------------------------------------------------------- Zustand, Historie, Balancing-Protokoll */

const state = { live: null, error: null, batteryError: null, inverter2Error: null, lastOk: 0, lastTry: 0, startedAt: Date.now() };
const rest = { lastActive: null, lastDir: null };   // wann floss zuletzt nennenswert Strom, und in welche Richtung
let history = [];
let balancing = {};
const BAL_FILE = path.join(DATA_DIR, 'balancing.json');
let balDirty = false;

function ymd(d) {
  const p = function (n) { return n < 10 ? '0' + n : '' + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function histFile(d) { return path.join(DATA_DIR, 'history-' + ymd(d) + '.jsonl'); }

function loadHistory() {
  const now = Date.now();
  for (let i = cfg.historyDays; i >= 0; i--) {
    const file = histFile(new Date(now - i * 86400000));
    if (!fs.existsSync(file)) continue;
    fs.readFileSync(file, 'utf8').split('\n').forEach(function (line) {
      if (!line) return;
      try { history.push(JSON.parse(line)); } catch (e) { /* defekte Zeile überspringen */ }
    });
  }
  try { balancing = JSON.parse(fs.readFileSync(BAL_FILE, 'utf8')); } catch (e) { balancing = {}; }
  for (let i = history.length - 1; i >= 0; i--) {
    if (Math.abs(history[i].bp) > 150) { rest.lastActive = history[i].t; rest.lastDir = history[i].bp > 0 ? 'charge' : 'discharge'; break; }
  }
  console.log('Historie geladen: ' + history.length + ' Messpunkte, ' + Object.keys(balancing).length + ' Balancing-Tage');
}

function cleanup() {
  const cutoff = Date.now() - cfg.retentionDays * 86400000;
  fs.readdirSync(DATA_DIR).forEach(function (name) {
    const m = /^history-(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(name);
    if (m && new Date(+m[1], +m[2] - 1, +m[3]).getTime() < cutoff) fs.unlinkSync(path.join(DATA_DIR, name));
  });
  const memCutoff = Date.now() - (cfg.historyDays + 1) * 86400000;
  while (history.length && history[0].t < memCutoff) history.shift();
}

let lastStored = 0;
function store(live) {
  const now = Date.now();
  if (now - lastStored < cfg.storeSeconds * 1000 - 500) return;
  lastStored = now;
  const i = live.inverter, c = live.cells;
  const s = {
    t: now, pv: i.pvPower, load: i.loadPower, grid: i.gridPower, bp: i.battery.power,
    soc: i.battery.soc, bv: i.battery.voltage, ba: i.battery.current, bt: i.battery.temp
  };
  if (live.inverter2) s.pv2 = live.inverter2.acPower;
  if (live.plant && live.plant.loadPower !== i.loadPower) s.pv2h = live.plant.loadPower - i.loadPower;   // Anteil fremder Erzeuger (Strings, Erzeuger-Messgeräte) an der Hauslast
  if (i.battery.bmsMaxCharge !== undefined) { s.bmc = i.battery.bmsMaxCharge; s.bmd = i.battery.bmsMaxDischarge; }
  if (heatpump) {
    const h = heatpump.state();
    if (h.live && now - h.at < 5 * 60000) { const v = h.live.values; if (v.elPower !== undefined) s.hpw = v.elPower; else if (h.live.running !== undefined) s.hpon = h.live.running ? 1 : 0; if (v.outdoorTemp !== undefined) s.hpt = v.outdoorTemp; }
  }
  if (meters) {
    const mh = meters.sumRole('heatpump'), mc = meters.sumRole('car'), mhouse = meters.sumRole('house');   // gemessene Werte haben Vorrang
    if (mh !== null) s.hpw = mh;
    if (mc !== null) s.carw = mc;
    if (mhouse !== null) s.mhouse = mhouse;
    const mpv = meters.sumRole('pv');
    if (mpv !== null) s.pvx = mpv;
  }
  if (forecast && live.plant) forecast.reportActual(live.plant.todayPv);
  if (c) {
    s.cmax = c.cellMax; s.cmin = c.cellMin;
    s.mmax = c.modules.map(function (m) { return m.max; });
    s.mmin = c.modules.map(function (m) { return m.min; });
  }
  history.push(s);
  fs.appendFile(histFile(new Date(now)), JSON.stringify(s) + '\n', function () {});
}

/* Pro Tag zwei Schnappschüsse: höchste Zellspannung (Ladeende) und niedrigste (Entladeende).
   Daran lässt sich ablesen, ob die Spreizung von Zyklus zu Zyklus kleiner wird. */
function trackBalancing(live) {
  const c = live.cells;
  if (!c || c.cellMax === null || c.cellMin === null) return;
  const day = ymd(new Date());
  const entry = balancing[day] || (balancing[day] = {});
  const snap = function () {
    return {
      t: Date.now(), soc: live.inverter.battery.soc, current: live.inverter.battery.current,
      cellMax: c.cellMax, cellMaxPos: c.cellMaxPos, cellMin: c.cellMin, cellMinPos: c.cellMinPos,
      spreadMv: c.spreadMv, moduleMax: c.modules.map(function (m) { return m.max; }),
      moduleMin: c.modules.map(function (m) { return m.min; })
    };
  };
  if (!entry.top || c.cellMax > entry.top.cellMax) { entry.top = snap(); balDirty = true; }
  // Unteres Knie: eine Zelle fällt unter 3,10 V, während der Rest des Turms noch deutlich höher steht.
  // Die SOC-Anzeige in diesem Moment entspricht ungefähr dem Rückstand dieses Moduls.
  if (!entry.knee && c.cellMin < 3.10 && live.inverter.battery.power <= 0) {
    const mins = c.modules.map(function (m) { return m.min; }).filter(function (v) { return v !== null; }).sort(function (x, y) { return x - y; });
    const med = mins[Math.floor(mins.length / 2)];
    if (med - c.cellMin > 0.06) {
      entry.knee = { t: Date.now(), soc: live.inverter.battery.soc, module: c.cellMinPos ? c.cellMinPos.module : null, cellMin: c.cellMin, medianMin: med };
      balDirty = true;
      console.log(new Date().toLocaleTimeString('de-DE') + ' Modul ' + entry.knee.module + ' ist als erstes leer, SOC-Anzeige ' + entry.knee.soc + ' %');
    }
  }
  if (!entry.bottom || c.cellMin < entry.bottom.cellMin) { entry.bottom = snap(); balDirty = true; }
}

setInterval(function () {
  if (!balDirty) return;
  balDirty = false;
  fs.writeFile(BAL_FILE, JSON.stringify(balancing), function () {});
}, 60000);

/* ---------------------------------------------------------------- Abfragezyklus */

const invClient = new ModbusTcp(cfg.inverter.host, cfg.inverter.port, cfg.timeoutMs);
const invMap = R.mapFor(cfg.inverter);
const invPlan = R.makePlan(invMap);
const invCore = invMap.filter(function (e) { return e.core; });
const battHost = cfg.battery.host || cfg.inverter.host;
const sameDevice = battHost === cfg.inverter.host && cfg.battery.port === cfg.inverter.port;
const battClient = sameDevice ? invClient : new ModbusTcp(battHost, cfg.battery.port, cfg.timeoutMs);

/* Stringwechselrichter: je einer mit eigenem Leseplan. Teilt einer Adresse und Port mit dem Hybrid, wird dessen Verbindung mitbenutzt. */
const strings = cfg.strings.map(function (sc) {
  const port = sc.port || 502, shared = sc.host === cfg.inverter.host && port === cfg.inverter.port;
  const map = R.mapFor(sc);
  return { cfg: sc, port: port, unitId: sc.unitId === undefined ? 1 : sc.unitId, shared: shared, client: shared ? invClient : new ModbusTcp(sc.host, port, cfg.timeoutMs),
    plan: R.makePlan(map), core: map.filter(function (e) { return e.core; }), last: null, at: 0, error: null };
});

function gap() { return new Promise(function (res) { setTimeout(res, cfg.requestGapMs); }); }

/* Tagesertrag für Geräte ohne eigenes Tagesregister: Gesamtzähler minus Stand um Mitternacht, in data/tagesstand.json gemerkt */
const DAY_FILE = path.join(DATA_DIR, 'tagesstand.json');
let dayBase = { day: '', values: {} };
try { dayBase = JSON.parse(fs.readFileSync(DAY_FILE, 'utf8')); } catch (e) { /* noch keiner */ }
function dayYield(st, total) {
  const d = new Date(), day = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  if (typeof total !== 'number' || !(total >= 0)) return 0;
  if (dayBase.day !== day) { dayBase = { day: day, values: {} }; }
  if (dayBase.values[st.cfg.name] === undefined || total < dayBase.values[st.cfg.name]) {
    dayBase.values[st.cfg.name] = total;
    try { fs.writeFileSync(DAY_FILE, JSON.stringify(dayBase)); } catch (e) { /* nicht kritisch */ }
  }
  return r(total - dayBase.values[st.cfg.name], 1);
}

function coreProblem(res, core) {
  if (res.aborted) return res.aborted;
  const miss = core.filter(function (e) { return res.values[e.key] === undefined; });
  return miss.length ? 'keine Werte für ' + miss.map(function (e) { return e.label + ' (' + e.addr + ')'; }).join(', ') + (res.errors[miss[0].key] ? ': ' + res.errors[miss[0].key] : '') : null;
}

function pollStrings() {
  let p = Promise.resolve();
  strings.forEach(function (st) {
    p = p.then(function () { return R.readPlan(st.client, st.unitId, st.plan, gap); }).then(function (res) {
      const why = coreProblem(res, st.core);
      if (why) throw new Error(why);
      st.last = decodeStringInverter(res.values, st.cfg.type === 'micro'); st.at = Date.now();
      if (st.last.todayKwh === null) st.last.todayKwh = dayYield(st, st.last.totalKwh);
      if (st.error) console.log(new Date().toLocaleTimeString('de-DE') + ' ' + st.cfg.name + ' wird wieder gelesen');
      st.error = null;
    }).catch(function (e) {
      if (st.error !== e.message) console.log(new Date().toLocaleTimeString('de-DE') + ' ' + st.cfg.name + ': ' + e.message);
      st.error = e.message;
      if (!st.shared) st.client.close();
    });
  });
  return p;
}

function pollOnce() {
  state.lastTry = Date.now();
  return pollStrings().then(function () { return R.readPlan(invClient, cfg.inverter.unitId, invPlan, gap); })
    .then(function (res) {
      const why = coreProblem(res, invCore);
      if (why) throw new Error(why);
      const v = res.values;
      if (!v.battVoltage && !v.soc && !v.soh) throw new Error('Wechselrichter liefert leere Batteriewerte, Messung verworfen');
      const live = { t: Date.now(), inverter: decodeInverter(v), settings: decodeSettings(v), cells: null };
      if (v.bmsMaxCharge !== undefined && v.bmsMaxDischarge !== undefined) { live.inverter.battery.bmsMaxCharge = v.bmsMaxCharge; live.inverter.battery.bmsMaxDischarge = v.bmsMaxDischarge; }
      if (cfg.winet.enabled) {
        if (winet.cells && Date.now() - winet.cellsAt < cfg.winet.intervalSeconds * 4000) live.cells = winet.cells;
        return live;
      }
      if (!cfg.battery.enabled) return live;
      return battClient.read(cfg.battery.unitId, 4, cfg.battery.cellBlockAddress, cfg.battery.cellBlockCount)
        .then(function (w) {
          if (w.length < 24) throw new Error('Zellblock unvollständig (' + w.length + ' Register)');
          while (w.length < 32) w.push(0xffff);
          live.cells = decodeCells(w);
          state.batteryError = null;
          return live;
        }, function (e) {
          state.batteryError = e.message;
          if (!sameDevice) battClient.close();
          return live;
        });
    })
    .then(function (live) {
      const inv = live.inverter;
      if (strings.length) {
        // nachts schaltet ein Stringwechselrichter ab: dann gilt 0 W statt eines Fehlers
        live.strings = strings.map(function (st) {
          const fresh = st.last && Date.now() - st.at < cfg.pollSeconds * 6000;
          return { name: st.cfg.name, data: fresh ? st.last : null, error: st.error, addToHouseLoad: st.cfg.addToHouseLoad !== false };
        });
        const on = live.strings.filter(function (x) { return x.data; });
        const sum = function (f) { return on.reduce(function (a, x) { return a + f(x); }, 0); };
        const p2 = sum(function (x) { return x.data.acPower; }), add = sum(function (x) { return x.addToHouseLoad ? x.data.acPower : 0; });
        live.inverter2 = on.length ? { acPower: p2, dcPower: sum(function (x) { return x.data.dcPower; }), todayKwh: r(sum(function (x) { return x.data.todayKwh; }), 1),
          totalKwh: sum(function (x) { return x.data.totalKwh; }), mppt: on[0].data.mppt, phaseVoltage: on[0].data.phaseVoltage, inverterTemp: on[0].data.inverterTemp } : null;
        live.plant = { pvPower: inv.pvPower + p2, loadPower: inv.loadPower + add, todayPv: r(inv.today.pv + (live.inverter2 ? live.inverter2.todayKwh : 0), 1) };
        const errs = strings.filter(function (st) { return st.error; }).map(function (st) { return st.cfg.name + ': ' + st.error; });
        state.inverter2Error = errs.length ? errs.join('; ') : null;
      } else {
        live.plant = { pvPower: inv.pvPower, loadPower: inv.loadPower, todayPv: inv.today.pv };
      }
      if (meters) {
        /* Erzeuger-Messgeräte (Mikrowechselrichter o. ä.): der Hybrid sieht deren Einspeisung am Zähler als eigene und weist
           die Hauslast um genau diesen Betrag zu niedrig aus. Deshalb kommt die gemessene Leistung zu Solar UND zu Haus dazu. */
        const mpv = meters.sumRole('pv');
        if (mpv !== null && mpv > 0) { live.plant.pvPower += mpv; live.plant.loadPower += mpv; live.plant.pvExtra = mpv; }
        const mkwh = meters.kwhRole('pv');
        if (mkwh > 0) { live.plant.todayPv = r(live.plant.todayPv + mkwh, 1); live.plant.todayPvExtra = r(mkwh, 2); }
      }
      const bat = inv.battery;
      if (Math.abs(bat.power) > 150) { rest.lastActive = Date.now(); rest.lastDir = bat.power > 0 ? 'charge' : 'discharge'; }
      bat.restMinutes = rest.lastActive ? Math.floor((Date.now() - rest.lastActive) / 60000) : null;
      bat.lastDirection = rest.lastDir;
      state.live = live;
      state.error = null;
      state.lastOk = Date.now();
      store(live);
      trackBalancing(live);
      if (control) control.tick();
    })
    .catch(function (e) {
      state.error = e.message;
      invClient.close();
    });
}

/* Für die Seite Anlage: alle Register einer (noch nicht gespeicherten) Wechselrichter-Einstellung lesen und anzeigen.
   Teilt das Gerät Adresse und Port mit einer laufenden Verbindung, wird diese mitbenutzt: der WiNet-S bedient nur wenige Clients. */
function testInverter(inv) {
  const running = [{ host: cfg.inverter.host, port: cfg.inverter.port, client: invClient }].concat(strings.map(function (st) { return { host: st.cfg.host, port: st.port, client: st.client }; }))
    .filter(function (x) { return CONFIGURED && x.host === inv.host && x.port === inv.port; })[0];
  const client = running ? running.client : new ModbusTcp(inv.host, inv.port, cfg.timeoutMs);
  const map = R.mapFor(inv), plan = R.makePlan(map);
  return R.readPlan(client, inv.unitId, plan, gap).then(function (res) {
    if (!running) client.close();
    const rows = map.map(function (e) {
      const raw = res.values[e.key];
      const scale = e.key === 'gridFrequency' && raw > 1000 ? 0.01 : e.scale;     // je nach Firmware 0,1 oder 0,01 Hz
      return { key: e.key, addr: e.addr, raw: raw === undefined ? null : raw, value: raw === undefined ? null : r(raw * scale, 3), error: res.errors[e.key] || null };
    });
    const why = coreProblem(res, map.filter(function (e) { return e.core; }));
    const val = function (k) { const x = rows.filter(function (q) { return q.key === k; })[0]; return x ? x.value : null; };
    const notes = [];
    if (inv.type === 'hybrid' && !why) {
      if (!(val('soc') >= 0 && val('soc') <= 100)) notes.push('Der Ladezustand liegt nicht zwischen 0 und 100 %: Adresse prüfen.');
      if (!(val('battVoltage') > 40 && val('battVoltage') < 1000)) notes.push('Die Batteriespannung ist unplausibel: Adresse prüfen oder ist das ein Stringwechselrichter?');
    }
    if ((inv.type === 'string' || inv.type === 'micro') && !why && !(val('acPower') >= 0 && val('acPower') < 200000)) notes.push('Die AC-Leistung ist unplausibel: Adresse prüfen.');
    return { ok: !why, error: why, rows: rows, notes: notes };
  }, function (e) { if (!running) client.close(); throw e; });
}

/* Abfrageschleife mit Selbstüberwachung: bleibt ein Zyklus länger als 90 Sekunden ohne Ergebnis hängen (etwa nach einem
   Neustart von Wechselrichter oder WiNet-S), werden die Verbindungen verworfen und die Schleife läuft neu an. */
let loopGen = 0;
function resetClient(c) {
  if (!c) return;
  try { c.close(); } catch (e) { /* egal */ }
  if (c.pending) { clearTimeout(c.pending.timer); c.pending = null; }
  c.chain = Promise.resolve();
}
function loop() {
  const gen = ++loopGen;
  let finished = false;
  const next = function () { if (gen === loopGen) setTimeout(loop, cfg.pollSeconds * 1000); };
  const guard = setTimeout(function () {
    if (finished || gen !== loopGen) return;
    finished = true;
    console.log(new Date().toLocaleString('de-DE') + ' Abfragezyklus hängt seit 90 Sekunden, Verbindungen werden neu aufgebaut');
    state.error = 'Abfrage hing, Verbindung wird neu aufgebaut';
    resetClient(invClient); if (battClient !== invClient) resetClient(battClient); strings.forEach(function (st) { if (!st.shared) resetClient(st.client); });
    next();
  }, 90000);
  pollOnce().then(function () { if (finished) return; finished = true; clearTimeout(guard); next(); },
                  function () { if (finished) return; finished = true; clearTimeout(guard); next(); });
}

/* ---------------------------------------------------------------- Steuerteil (Einstellungen, Matching) */

let control = null;
if (CONFIGURED && (!cfg.control || cfg.control.enabled !== false)) {
  try { control = require('./control')({ cfg: cfg, state: state, invClient: invClient, dataDir: DATA_DIR, reg: function (key) { return R.addressOf(cfg.inverter, key); } }); }
  catch (e) { console.log('Steuerteil nicht geladen (' + e.message + '). Der Monitor läuft trotzdem.'); }
}

/* ---------------------------------------------------------------- Wärmepumpe, Preise, Prognose, Planer */

const tlog = function (t) { console.log(new Date().toLocaleTimeString('de-DE') + ' ' + t); };
let heatpump = null, prices = null, forecast = null, planner = null, meters = null;
if (CONFIGURED) {
  try {
    if (Array.isArray(cfg.meters) && cfg.meters.length) meters = require('./meters')({ cfg: cfg.meters, timeoutMs: cfg.timeoutMs, dataDir: DATA_DIR, log: tlog });
    if (cfg.heatpump.enabled && cfg.heatpump.host) heatpump = require('./heatpump')({ cfg: cfg.heatpump, timeoutMs: cfg.timeoutMs, requestGapMs: 100, log: tlog });
    prices = require('./prices')({ cfg: cfg.prices, dataDir: DATA_DIR, log: tlog, onUpdate: function () { if (planner) planner.invalidate(); } });
    forecast = require('./forecast')({ cfg: cfg.forecast, dataDir: DATA_DIR, log: tlog, onUpdate: function () { if (planner) planner.invalidate(); } });
    planner = require('./planner')({ cfg: cfg.planner, dataDir: DATA_DIR, prices: prices, forecast: forecast, heatpump: heatpump,
      live: function () { return state.live; }, lastOk: function () { return state.lastOk; }, history: function () { return history; },
      matchingActive: function () { return !!(control && control.isActive()); },
      applyEms: function (want) { return control ? control.applyEms(want) : Promise.reject(new Error('Steuerteil nicht geladen')); },
      saveMode: function (mode) { try { setup.setPlannerMode(mode); } catch (e) { tlog('Betriebsart des Planers konnte nicht gespeichert werden: ' + e.message); } } });
  } catch (e) { console.log('Planer nicht geladen (' + e.message + ').'); planner = null; }
}

/* ---------------------------------------------------------------- HTTP */

function sendJson(res, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Build': BUILD });
  res.end(body);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function serveStatic(reqPath, res) {
  const rel = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (file.indexOf(PUBLIC_DIR) !== 0) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, function (err, data) {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Nicht gefunden'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

/* Neustart nach dem Speichern auf der Seite Anlage. Läuft das Programm unter einem Dienstverwalter (systemd setzt INVOCATION_ID,
   sonst SUNGROW_SUPERVISED=1 setzen), beendet es sich und wird von dort neu gestartet. Sonst startet es sich selbst neu. */
function restart() {
  console.log(new Date().toLocaleString('de-DE') + ' Neustart mit der neuen Konfiguration');
  try { fs.writeFileSync(BAL_FILE, JSON.stringify(balancing)); } catch (e) { /* egal */ }
  server.close();
  const settle = planner ? planner.stop().catch(function () {}) : Promise.resolve();
  Promise.race([settle, new Promise(function (r) { setTimeout(r, 4000); })]).then(function () { setTimeout(function () {
    if (process.env.INVOCATION_ID || process.env.SUNGROW_SUPERVISED) process.exit(0);
    const out = fs.openSync(path.join(DATA_DIR, 'steuerung.log'), 'a');
    const child = require('child_process').spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, detached: true, stdio: ['ignore', out, out], env: process.env });
    // Hinweis: unter systemd oder Docker (SUNGROW_SUPERVISED=1) kommt es nicht hierher, dort startet der Dienstverwalter neu
    child.unref();
    process.exit(0);
  }, 300); });
}

const setup = require('./setup')({ root: ROOT, configFile: CONFIG_FILE, cfg: cfg, configured: function () { return CONFIGURED; }, restart: restart, busy: function () { return !!(control && control.isActive()); },
  testInverter: testInverter, testWinet: testWinet });
const PAGES = ['/', '/index.html', '/einstellungen', '/matching', '/steuerung.html', '/planer', '/planer.html'];

const server = http.createServer(function (req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (setup.handle(req, res, url)) return;
  if (url.pathname === '/anlage') return serveStatic('/anlage.html', res);
  if (!CONFIGURED) {
    if (PAGES.indexOf(url.pathname) >= 0) { res.writeHead(302, { Location: '/anlage' }); res.end(); return; }
    if (url.pathname.indexOf('/api/') === 0) { res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'Noch nicht eingerichtet: bitte die Seite Anlage öffnen.', setup: true })); return; }
    return serveStatic(url.pathname, res);
  }
  if (url.pathname === '/api/live') {
    return sendJson(res, {
      now: Date.now(), lastTry: state.lastTry, lastOk: state.lastOk, error: state.error, batteryError: state.batteryError, inverter2Error: state.inverter2Error,
      live: state.live,
      meters: meters ? meters.state() : [],
      flow: cfg.flow,
      heatpump: heatpump ? (function (h) { return { name: h.name, live: h.live, at: h.at, error: h.error, shift: h.shift }; })(heatpump.state()) : null,
      meta: {
        plantName: cfg.plantName, inverterName: cfg.inverter.name || 'Hybrid', winetPausedUntil: winetPauseUntil,
        strings: strings.map(function (st) { return { name: st.cfg.name, host: st.cfg.host + ':' + st.port, addToHouseLoad: st.cfg.addToHouseLoad !== false }; }),
        inverter2: strings.length ? { name: strings.length === 1 ? strings[0].cfg.name : 'Stringwechselrichter', host: strings.map(function (st) { return st.cfg.host + ':' + st.port; }).join(', '), addToHouseLoad: strings.some(function (st) { return st.cfg.addToHouseLoad !== false; }) } : null, moduleCount: cfg.moduleCount, topModuleIndex: cfg.topModuleIndex,
        moduleNotes: cfg.moduleNotes, pollSeconds: cfg.pollSeconds, planner: planner ? planner.view().mode : null, heatpump: heatpump ? heatpump.state().name : null,
        inverter: cfg.inverter.host + ':' + cfg.inverter.port, battery: cfg.winet.enabled ? 'WiNet-S ' + winetHost() + ', Web-Schnittstelle' : battHost + ':' + cfg.battery.port + ' / Unit ' + cfg.battery.unitId, cellSource: cfg.winet.enabled ? 'winet' : 'modbus'
      }
    });
  }
  if (url.pathname === '/api/history') {
    const hours = Math.min(Math.max(parseFloat(url.searchParams.get('hours')) || 24, 0.25), (cfg.historyDays + 1) * 24);
    const maxPoints = Math.min(parseInt(url.searchParams.get('points'), 10) || 720, 3000);
    const from = Date.now() - hours * 3600000;
    const slice = history.filter(function (s) { return s.t >= from; });
    const stride = Math.max(1, Math.ceil(slice.length / maxPoints));
    return sendJson(res, slice.filter(function (_, i) { return i % stride === 0 || i === slice.length - 1; }));
  }
  if (url.pathname === '/api/balancing') return sendJson(res, balancing);
  if (url.pathname === '/api/winet-pause' && req.method === 'POST') {
    let body = '';
    req.on('data', function (c) { body += c; if (body.length > 500) req.destroy(); });
    req.on('end', function () {
      let minutes = 0; try { minutes = Number(JSON.parse(body).minutes) || 0; } catch (e) { /* leer */ }
      if (control && control.isActive() && minutes > 0) return sendJson(res, { error: 'Während eines Matching-Ablaufs werden die Zellwerte gebraucht, die Freigabe ist gesperrt.', until: winetPauseUntil });
      winetPauseUntil = minutes > 0 ? Date.now() + Math.min(minutes, 120) * 60000 : 0;
      if (!minutes) { state.batteryError = null; console.log(new Date().toLocaleTimeString('de-DE') + ' WiNet-S wird wieder benutzt'); }
      sendJson(res, { until: winetPauseUntil });
    });
    return;
  }
  if (url.pathname === '/api/planer') {
    if (!planner) return sendJson(res, { error: 'Planer nicht geladen' });
    if (req.method === 'POST') {
      let body = '';
      req.on('data', function (c) { body += c; if (body.length > 2000) req.destroy(); });
      req.on('end', function () {
        let j = {}; try { j = JSON.parse(body); } catch (e) { /* leer */ }
        let err = null;
        if (j.action === 'mode') err = planner.setMode(j.mode);
        else if (j.action === 'replan') { try { planner.replan(); } catch (e) { err = e.message; } }
        else if (j.action === 'refresh') { prices.refresh(); forecast.refresh(); if (heatpump) heatpump.readOnce(); }
        else err = 'Unbekannte Aktion';
        sendJson(res, { error: err, state: planner.view() });
      });
      return;
    }
    return sendJson(res, planner.view());
  }
  if (control && control.handle(req, res, url)) return;
  if (url.pathname.indexOf('/api/') === 0) { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'unbekannt' })); return; }
  if (url.pathname === '/einstellungen' || url.pathname === '/matching') return serveStatic('/steuerung.html', res);
  if (url.pathname === '/planer') return serveStatic('/planer.html', res);
  serveStatic(url.pathname, res);
});

loadHistory();
cleanup();
setInterval(cleanup, 6 * 3600000);
server.on('error', function (e) {
  console.log('Weboberfläche kann nicht starten (' + (e.code === 'EADDRINUSE' ? 'Port ' + cfg.http.port + ' ist schon belegt, läuft das Programm schon?' : e.message) + ')');
  process.exit(1);
});
server.listen(cfg.http.port, function () {
  try { fs.writeFileSync(path.join(DATA_DIR, 'steuerung.pid'), String(process.pid)); } catch (e) { /* egal */ }
  if (CONF_DIR !== ROOT) console.log('Konfiguration und Daten in ' + CONF_DIR);
  if (!CONFIGURED) {
    console.log('Sungrow Steuerung läuft auf Port ' + cfg.http.port + ' im Einrichtungsmodus: im Browser http://<Rechner>:' + cfg.http.port + '/anlage öffnen.');
    return;
  }
  console.log('Sungrow Steuerung läuft auf Port ' + cfg.http.port + (control ? ' (Monitor, Einstellungen, Matching, Anlage)' : ' (nur Monitor und Anlage, Steuerteil abgeschaltet)'));
  console.log('Hybrid: ' + (cfg.inverter.name || 'Hybrid') + ' (' + R.modelOf(cfg.inverter).label + ') ' + cfg.inverter.host + ':' + cfg.inverter.port + ' (Unit ' + cfg.inverter.unitId + ')' + (invMap.some(function (e) { return e.custom; }) ? ', mit eigenen Registeradressen' : ''));
  strings.forEach(function (st) { console.log('String: ' + st.cfg.name + ' (' + R.modelOf(st.cfg).label + ') ' + st.cfg.host + ':' + st.port + ' (Unit ' + st.unitId + ')'); });
  if (cfg.winet.enabled) { console.log('Zellwerte: über die Web-Schnittstelle des WiNet-S (' + winetHost() + ':' + cfg.winet.port + ')'); winetLoop(); }
  else if (cfg.battery.enabled) console.log('Batterie: ' + battHost + ':' + cfg.battery.port + ' (Unit ' + cfg.battery.unitId + ')');
  loop();
  if (heatpump) heatpump.start();
  if (meters) meters.start();
  if (prices) prices.start();
  if (forecast) forecast.start();
  if (planner) { planner.start(); console.log('Planer: ' + ({ off: 'aus', simulate: 'Simulation', active: 'AKTIV' })[cfg.planner.mode] + (cfg.prices.exchange === 'none' ? ', ohne Börsenpreise' : ', Börse ' + cfg.prices.exchange)); }
});

let ending = false;
function shutdown() {
  if (ending) return; ending = true;
  try { fs.writeFileSync(BAL_FILE, JSON.stringify(balancing)); } catch (e) { /* egal */ }
  // Planer zurücknehmen: Wechselrichter auf Eigenverbrauch, Verschiebung der Wärmepumpe auf 0
  if (meters) meters.stop();
  const settle = planner ? planner.stop().catch(function () {}) : Promise.resolve();
  Promise.race([settle, new Promise(function (r) { setTimeout(r, 4000); })]).then(function () { process.exit(0); });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
