'use strict';
/*
 * Sungrow Steuerung – (C) by Elric M.
 * Nur für die private Nutzung zu Test- und Lernzwecken. Kommerzielle Verwendung jeder Art, die Verwendung im
 * Geschäftsbetrieb und der Weiterverkauf sind untersagt. Benutzung auf eigene Gefahr, ohne Gewährleistung oder Garantie.
 * Einzelheiten: LICENSE und HANDBUCH.md.
 */
/*
 * Wärmepumpe über Modbus (Modbus TCP oder RTU über TCP, z. B. per RS485-Ethernet-Umsetzer).
 *
 * Vorbelegt ist die Registerkarte einer Weishaupt WWP S mit Carel-Regler pCO5+. Jedes Register lässt sich auf der Seite
 * Anlage ändern (Doku-Nr., Format, Faktor) und einzeln ein- oder ausschalten. Die Doku-Nr. folgt der klassischen
 * Modbus-Schreibweise: 3xxxx = Input-Register (FC04), 4xxxx = Holding-Register (FC03), jeweils ab 1 gezählt.
 *
 * GESCHRIEBEN wird genau ein Register: die Sollwert-Verschiebung PV (Smart Grid). Sie liegt im RAM des Reglers.
 * Alle anderen Register bleiben Leseregister, auch wenn sie Holding-Register sind: Sollwerte, Heizkurve und Betriebsart
 * landen im EEPROM des Reglers, der nur wenige zehntausend Schreibzyklen verträgt. Eine Steuerung, die alle paar
 * Minuten nachregelt, würde ihn in ein paar Jahren zerstören. Deshalb gibt es hier eine feste Weißliste.
 */
const R = require('./registers');
const ModbusClient = require('./modbus-client');

/* Standardkarte. 'ungeprüft' heißt: Adresse aus einer Weishaupt-Registerliste übernommen, an der WWP S nicht nachgemessen. */
const WEISHAUPT = [
  { key: 'outdoorTemp', group: 'Temperaturen', label: 'Außentemperatur', fc: 4, addr: 0, type: 's16', scale: 0.1, unit: '°C', on: true, verified: false },
  { key: 'flowTemp', group: 'Temperaturen', label: 'Vorlauftemperatur', fc: 4, addr: 3103, type: 's16', scale: 0.1, unit: '°C', on: true, verified: false },
  { key: 'returnTemp', group: 'Temperaturen', label: 'Rücklauftemperatur', fc: 4, addr: 3104, type: 's16', scale: 0.1, unit: '°C', on: true, verified: false },
  { key: 'dhwTemp', group: 'Temperaturen', label: 'Warmwasser Ist', fc: 4, addr: 2101, type: 's16', scale: 0.1, unit: '°C', on: true, verified: false },
  { key: 'dhwSet', group: 'Sollwerte', label: 'Warmwasser Soll', fc: 4, addr: 2100, type: 's16', scale: 0.1, unit: '°C', on: true, verified: false },
  { key: 'roomSet', group: 'Sollwerte', label: 'Raum Soll Heizkreis 1', fc: 4, addr: 1100, type: 's16', scale: 0.1, unit: '°C', on: true, verified: false },
  { key: 'flowSet', group: 'Sollwerte', label: 'Vorlauf Soll Heizkreis 1', fc: 4, addr: 1103, type: 's16', scale: 0.1, unit: '°C', on: true, verified: false },
  { key: 'heatCurve', group: 'Sollwerte', label: 'Heizkurve (nur lesen)', fc: 3, addr: 1107, type: 'u16', scale: 0.01, unit: '', on: false, verified: false },
  { key: 'opMode', group: 'Zustand', label: 'Betriebsart (1 Heizen, 3 Sommer, 4 Standby, nur lesen)', fc: 3, addr: 0, type: 'u16', scale: 1, unit: '', on: true, verified: false },
  { key: 'state', group: 'Zustand', label: 'Betriebszustand (Code)', fc: 4, addr: 5, type: 'u16', scale: 1, unit: '', on: true, verified: false },
  { key: 'faultFree', group: 'Zustand', label: 'Störungsfrei (1 = ja)', fc: 4, addr: 4, type: 'u16', scale: 1, unit: '', on: true, verified: false },
  { key: 'demandPct', group: 'Zustand', label: 'Leistungsanforderung', fc: 4, addr: 3102, type: 'u16', scale: 1, unit: '%', on: true, verified: false },
  { key: 'compressor', group: 'Zustand', label: 'Verdichter (1 = läuft)', fc: 4, addr: 0, type: 'u16', scale: 1, unit: '', on: false, verified: false },
  { key: 'elPower', group: 'Energie', label: 'Elektrische Leistung', fc: 4, addr: 0, type: 'u16', scale: 1, unit: 'W', on: false, verified: false },
  { key: 'energyToday', group: 'Energie', label: 'Energie heute', fc: 4, addr: 6100, type: 'u16', scale: 1, unit: 'kWh', on: true, verified: false },
  { key: 'pvShift', group: 'Steuerung', label: 'Sollwert-Verschiebung PV (Smart Grid)', fc: 3, addr: 1, type: 's16', scale: 1, unit: 'K', on: true, verified: true, writable: true }
];
const STATE_CODES = { 8: 'Abtauen', 15: 'Standzeit', 19: 'Heizen', 20: 'Warmwasser', 25: 'Sommer' };
const OP_MODES = { 1: 'Heizen', 3: 'Sommer', 4: 'Standby' };
const TYPES = { weishaupt: { label: 'Weishaupt WWP S (Carel pCO5+)', map: WEISHAUPT } };
const WRITABLE = ['pvShift'];

function docNo(fc, addr) { return (fc === 4 ? 30001 : 40001) + addr; }
function fromDocNo(n) {
  n = Number(n);
  if (!Number.isInteger(n)) return null;
  if (n >= 30001 && n <= 39999) return { fc: 4, addr: n - 30001 };
  if (n >= 40001 && n <= 49999) return { fc: 3, addr: n - 40001 };
  if (n >= 0 && n <= 65535) return { fc: 3, addr: n };          // nackte 0-basierte Adresse: Holding
  return null;
}

/* Karte aus Standard plus Abweichungen aus der Konfiguration (hp.registers = { key: {fc, addr, type, scale, on} }) */
function mapFor(hp) {
  const t = TYPES[(hp && hp.model) || 'weishaupt'] || TYPES.weishaupt, over = (hp && hp.registers) || {};
  return t.map.map(function (e) {
    const o = over[e.key] || {};
    const out = Object.assign({}, e, {
      fc: o.fc === 3 || o.fc === 4 ? o.fc : e.fc,
      addr: Number.isInteger(o.addr) && o.addr >= 0 && o.addr <= 65535 ? o.addr : e.addr,
      type: o.type === 'u16' || o.type === 's16' ? o.type : e.type,
      scale: typeof o.scale === 'number' && o.scale > 0 ? o.scale : e.scale,
      on: typeof o.on === 'boolean' ? o.on : e.on,
      writable: WRITABLE.indexOf(e.key) >= 0
    });
    out.words = 1; out.doc = docNo(out.fc, out.addr);
    out.custom = out.fc !== e.fc || out.addr !== e.addr || out.type !== e.type || out.scale !== e.scale || out.on !== e.on;
    return out;
  });
}

function decode(map, raw) {
  const v = {};
  map.forEach(function (e) { if (raw[e.key] !== undefined) v[e.key] = Math.round(raw[e.key] * e.scale * 1000) / 1000; });
  const out = { values: v };
  if (v.state !== undefined) out.stateText = STATE_CODES[v.state] || ('Zustand ' + v.state);
  if (v.opMode !== undefined) out.opModeText = OP_MODES[v.opMode] || ('Betriebsart ' + v.opMode);
  if (v.compressor !== undefined) out.running = v.compressor > 0;
  else if (v.state !== undefined) out.running = v.state === 19 || v.state === 20;
  else if (v.demandPct !== undefined) out.running = v.demandPct > 0;
  return out;
}

module.exports = function (ctx) {
  const hp = ctx.cfg;                       // Abschnitt heatpump aus config.json
  const log = ctx.log || function (t) { console.log(new Date().toLocaleTimeString('de-DE') + ' ' + t); };
  const map = mapFor(hp);
  const active = map.filter(function (e) { return e.on; });
  const plan = R.makePlan(active);
  const client = new ModbusClient(hp.host, hp.port || 502, ctx.timeoutMs || 4000, hp.framing);
  const unit = hp.unitId === undefined ? 1 : hp.unitId;
  const S = { live: null, at: 0, error: null, shift: null, shiftAt: 0, shiftWanted: 0, writeError: null, writes: 0, lastWrite: 0 };
  let timer = null, stopped = false;

  function gap() { return new Promise(function (res) { setTimeout(res, ctx.requestGapMs || 100); }); }

  function readOnce() {
    return R.readPlan(client, unit, plan, gap).then(function (res) {
      if (res.aborted && !Object.keys(res.values).length) throw new Error(res.aborted);
      const d = decode(map, res.values);
      d.t = Date.now(); d.errors = res.errors;
      if (d.values.pvShift !== undefined) { S.shift = d.values.pvShift; S.shiftAt = d.t; }
      if (S.error) log('Wärmepumpe wird wieder gelesen');
      S.live = d; S.at = d.t; S.error = null;
      return d;
    }).catch(function (e) {
      if (S.error !== e.message) log('Wärmepumpe: ' + e.message);
      S.error = e.message;
      client.close();
    });
  }

  function loop() {
    if (stopped) return;
    readOnce().then(function () { if (!stopped) timer = setTimeout(loop, Math.max(5, hp.pollSeconds || 30) * 1000); });
  }

  /* Schreiben: nur Schlüssel aus der Weißliste, nur wenn in der Konfiguration freigegeben, nur innerhalb der Grenzen. */
  function write(key, value) {
    const e = map.filter(function (x) { return x.key === key; })[0];
    if (!e || !e.writable) return Promise.reject(new Error('Register „' + key + '“ darf nicht geschrieben werden'));
    if (!hp.writeEnabled) return Promise.reject(new Error('Schreiben auf die Wärmepumpe ist auf der Seite Anlage nicht freigegeben'));
    const lim = hp.shift || {};
    const lo = typeof lim.min === 'number' ? lim.min : -3, hi = typeof lim.max === 'number' ? lim.max : 5;
    const raw = Math.round(Math.max(lo, Math.min(hi, Number(value) || 0)) / e.scale), v = Math.round(raw * e.scale * 1000) / 1000;
    return client.write(unit, e.addr, raw < 0 ? raw + 0x10000 : raw).then(function () {
      S.writes++; S.lastWrite = Date.now(); S.writeError = null; S.shift = v; S.shiftAt = Date.now();
      log('Wärmepumpe: ' + e.label + ' = ' + v + ' ' + e.unit);
      return v;
    }, function (err) { S.writeError = err.message; log('Wärmepumpe, Schreiben fehlgeschlagen: ' + err.message); client.close(); throw err; });
  }

  /* Verschiebung setzen, aber nur bei Änderung; "0" ist der sichere Zustand. */
  function setShift(value) {
    S.shiftWanted = value;
    const e = map.filter(function (x) { return x.key === 'pvShift'; })[0];
    const lim = hp.shift || {}, lo = typeof lim.min === 'number' ? lim.min : -3, hi = typeof lim.max === 'number' ? lim.max : 5;
    const eff = e ? Math.round(Math.round(Math.max(lo, Math.min(hi, Number(value) || 0)) / e.scale) * e.scale * 1000) / 1000 : value;
    if (S.shift !== null && Math.abs(S.shift - eff) < 1e-9) return Promise.resolve(eff);
    return write('pvShift', value);
  }

  function stop(resetShift) {
    stopped = true; if (timer) clearTimeout(timer);
    const p = resetShift && hp.writeEnabled && S.shift !== null && S.shift !== 0 ? write('pvShift', 0).catch(function () {}) : Promise.resolve();
    return p.then(function () { client.close(); });
  }

  return {
    start: function () { if (!hp.host) return; log('Wärmepumpe: ' + (hp.name || 'Wärmepumpe') + ' ' + hp.host + ':' + (hp.port || 502) + ' (' + (hp.framing === 'rtu' ? 'RTU über TCP' : 'Modbus TCP') + ', Unit ' + unit + ')' + (hp.writeEnabled ? ', Schreiben freigegeben' : ', nur lesen')); loop(); },
    stop: stop, setShift: setShift, write: write, readOnce: readOnce,
    state: function () { return { name: hp.name || 'Wärmepumpe', live: S.live, at: S.at, error: S.error, shift: S.shift, shiftWanted: S.shiftWanted, writeEnabled: !!hp.writeEnabled, writeError: S.writeError, writes: S.writes, lastWrite: S.lastWrite, map: map.map(function (e) { return { key: e.key, label: e.label, unit: e.unit, on: e.on, writable: e.writable, doc: e.doc }; }) }; },
    map: map
  };
};

/* Für die Seite Anlage: alle eingeschalteten Register einer noch nicht gespeicherten Einstellung einmal lesen */
module.exports.test = function (hp, timeoutMs) {
  const map = mapFor(hp), active = map.filter(function (e) { return e.on; }), plan = R.makePlan(active);
  const client = new ModbusClient(hp.host, hp.port || 502, timeoutMs || 4000, hp.framing);
  const unit = hp.unitId === undefined ? 1 : hp.unitId;
  const gap = function () { return new Promise(function (res) { setTimeout(res, 100); }); };
  return R.readPlan(client, unit, plan, gap).then(function (res) {
    client.close();
    const rows = map.map(function (e) {
      const raw = res.values[e.key];
      return { key: e.key, on: e.on, raw: raw === undefined ? null : raw, value: raw === undefined ? null : Math.round(raw * e.scale * 1000) / 1000, error: res.errors[e.key] || null };
    });
    const got = rows.filter(function (x) { return x.value !== null; }).length;
    const notes = [];
    const val = function (k) { const x = rows.filter(function (q) { return q.key === k; })[0]; return x ? x.value : null; };
    if (got && val('outdoorTemp') !== null && (val('outdoorTemp') < -40 || val('outdoorTemp') > 50)) notes.push('Die Außentemperatur ist unplausibel: Doku-Nr., Format oder Faktor prüfen.');
    if (got && val('flowTemp') !== null && (val('flowTemp') < 0 || val('flowTemp') > 90)) notes.push('Die Vorlauftemperatur ist unplausibel: Doku-Nr., Format oder Faktor prüfen.');
    return { ok: !res.aborted && got > 0, error: res.aborted || (got ? null : 'Kein Register lieferte einen Wert'), rows: rows, notes: notes, read: got, total: active.length };
  }, function (e) { client.close(); throw e; });
};
module.exports.TYPES = TYPES;
module.exports.mapFor = mapFor;
module.exports.docNo = docNo;
module.exports.fromDocNo = fromDocNo;
module.exports.WRITABLE = WRITABLE;
module.exports.STATE_CODES = STATE_CODES;
