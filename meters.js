'use strict';
/*
 * Sungrow Steuerung – (C) by Elric M.
 * Nur für die private Nutzung zu Test- und Lernzwecken. Kommerzielle Verwendung jeder Art, die Verwendung im
 * Geschäftsbetrieb und der Weiterverkauf sind untersagt. Benutzung auf eigene Gefahr, ohne Gewährleistung oder Garantie.
 * Einzelheiten: LICENSE und HANDBUCH.md.
 */
/*
 * Messgeräte: frei konfigurierbare Leistungsmesser für den Energiefluss und das Lernen des Planers.
 *
 * Jedes Messgerät liefert eine Leistung in Watt und hat eine Rolle:
 *   house     Hausverbrauch (ersetzt im Energiefluss den vom Wechselrichter gerechneten Wert)
 *   heatpump  Wärmepumpe (geht in den Verlauf und damit in die gelernte Heizlast)
 *   car       E-Auto / Wallbox (eigener Knoten, wird aus dem Lastprofil herausgerechnet)
 *   custom    frei benannter Verbraucher (nur Anzeige)
 *
 * Quellen:
 *   modbus    Modbus TCP oder RTU über TCP, ein Register (u16, s16, u32, s32, float32 in beiden Wortfolgen) mit Faktor.
 *             Vorlagen: Eastron SDM630/SDM120/SDM72 (Gesamtwirkleistung, Doku-Nr. 30013, float32).
 *   loxone    Loxone Miniserver: GET /jdev/sps/io/<Objektname> mit Benutzer und Passwort, Wert aus LL.value
 *   http      beliebige JSON-Schnittstelle (Shelly, Tasmota, Wallbox): Adresse plus Pfad zum Wert, z. B. emeters.0.power
 * Modbus-Verbindungen zum selben Host/Port werden geteilt; ein RS485-Bus hat nur einen Master.
 */
const R = require('./registers');
const fs = require('fs');
const path = require('path');
const ModbusClient = require('./modbus-client');
const web = require('./web');

const TEMPLATES = [
  { id: 'sdm630', label: 'Eastron SDM630 (Gesamtwirkleistung)', fc: 4, doc: 30013, type: 'f32', scale: 1, unitId: 1 },
  { id: 'sdm120', label: 'Eastron SDM120 / SDM230 (Wirkleistung)', fc: 4, doc: 30013, type: 'f32', scale: 1, unitId: 1 },
  { id: 'sdm72', label: 'Eastron SDM72 (Gesamtwirkleistung)', fc: 4, doc: 30053, type: 'f32', scale: 1, unitId: 1 },
  { id: 'generic', label: 'Anderes Gerät (Register selbst eintragen)', fc: 4, doc: 30001, type: 'u16', scale: 1, unitId: 1 }
];
/* pv = Erzeuger (z. B. Mikrowechselrichter hinter einem Shelly oder SDM120): wird zu Solar und zum Hausverbrauch addiert,
   weil der Hybridwechselrichter fremde Einspeisung als eigene verbucht und seine Hauslast dadurch zu niedrig ausweist. */
const ROLES = { house: 'Haus', heatpump: 'Wärmepumpe', car: 'E-Auto', pv: 'Erzeuger', custom: 'Verbraucher' };
const TYPES = { u16: 1, s16: 1, u32: 2, s32: 2, u32le: 2, s32le: 2, f32: 2, f32le: 2 };

function decodeWords(type, w) {
  if (w.length < TYPES[type]) return null;
  const b = Buffer.alloc(4);
  if (type === 'u16') return w[0];
  if (type === 's16') return w[0] > 0x7fff ? w[0] - 0x10000 : w[0];
  const hiFirst = type === 'u32' || type === 's32' || type === 'f32';
  b.writeUInt16BE(hiFirst ? w[0] : w[1], 0); b.writeUInt16BE(hiFirst ? w[1] : w[0], 2);
  if (type === 'u32' || type === 'u32le') return b.readUInt32BE(0);
  if (type === 's32' || type === 's32le') return b.readInt32BE(0);
  const f = b.readFloatBE(0); return isFinite(f) ? f : null;
}
function jsonPath(obj, path) {
  let cur = obj;
  String(path || '').split('.').filter(Boolean).forEach(function (k) { if (cur !== null && cur !== undefined) cur = cur[k]; });
  return cur;
}
function toNumber(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const m = /-?\d+(?:[.,]\d+)?/.exec(String(v === undefined || v === null ? '' : v));
  return m ? parseFloat(m[0].replace(',', '.')) : null;
}

/* Einen Messwert lesen; clientPool: { 'host:port:framing': ModbusClient } */
function readOne(m, clientPool, timeoutMs) {
  if (m.source === 'modbus') {
    const key = m.host + ':' + (m.port || 502) + ':' + (m.framing === 'tcp' ? 'tcp' : 'rtu');
    const c = clientPool[key] || (clientPool[key] = new ModbusClient(m.host, m.port || 502, timeoutMs || 4000, m.framing));
    const fa = typeof m.addr === 'number' ? { fc: m.fc || 4, addr: m.addr } : null;
    if (!fa) return Promise.reject(new Error('Registeradresse fehlt'));
    return c.read(m.unitId === undefined ? 1 : m.unitId, fa.fc, fa.addr, TYPES[m.type] || 1).then(function (w) {
      const v = decodeWords(m.type || 'u16', w); if (v === null) throw new Error('Antwort zu kurz oder kein gültiger Wert');
      return v * (m.scale || 1);
    }, function (e) { c.close(); throw e; });
  }
  if (m.source === 'loxone') {
    const url = 'http://' + m.host + (m.port && m.port !== 80 ? ':' + m.port : '') + '/jdev/sps/io/' + encodeURIComponent(m.object || '');
    return web.fetchJson(url, timeoutMs || 6000, 0, { auth: (m.username || '') + ':' + (m.password || '') }).then(function (j) {
      const ll = j && j.LL; if (!ll) throw new Error('Miniserver: unerwartete Antwort');
      if (String(ll.Code) !== '200') throw new Error('Miniserver meldet Code ' + ll.Code + (String(ll.Code) === '404' ? ' (Objekt „' + m.object + '“ nicht gefunden – Name in Loxone Config prüfen)' : ''));
      const v = toNumber(ll.value); if (v === null) throw new Error('Miniserver: Wert „' + ll.value + '“ ist keine Zahl');
      return v * (m.scale || 1);
    });
  }
  if (m.source === 'http') {
    return web.fetchJson(m.url, timeoutMs || 6000, 0, m.username ? { auth: m.username + ':' + (m.password || '') } : {}).then(function (j) {
      const v = toNumber(jsonPath(j, m.path)); if (v === null) throw new Error('Wert unter „' + m.path + '“ nicht gefunden oder keine Zahl');
      return v * (m.scale || 1);
    });
  }
  return Promise.reject(new Error('unbekannte Quelle'));
}

module.exports = function (ctx) {
  const list = (ctx.cfg || []).filter(function (m) { return m && m.enabled !== false && m.name; });
  const log = ctx.log || function (t) { console.log(new Date().toLocaleTimeString('de-DE') + ' ' + t); };
  const pool = {};
  const S = list.map(function (m) { return { cfg: m, watts: null, at: 0, error: null, timer: null, kwh: 0 }; });
  let stopped = false;

  /* Tagesenergie je Messgerät (Rechteckintegration der Leistung), über Neustarts hinweg in einer kleinen Datei gemerkt */
  const dayFile = ctx.dataDir ? path.join(ctx.dataDir, 'messgeraete-tag.json') : null;
  function today() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  let day = today(), lastSave = 0;
  try {
    if (dayFile && fs.existsSync(dayFile)) { const j = JSON.parse(fs.readFileSync(dayFile, 'utf8')); if (j.day === day) S.forEach(function (st) { if (typeof j.kwh[st.cfg.name] === 'number') st.kwh = j.kwh[st.cfg.name]; }); }
  } catch (e) { log('Messgeräte: Tagesenergie nicht geladen (' + e.message + ')'); }
  function saveDay(force) {
    if (!dayFile || (!force && Date.now() - lastSave < 60000)) return;
    lastSave = Date.now();
    const kwh = {}; S.forEach(function (st) { kwh[st.cfg.name] = st.kwh; });
    try { fs.writeFileSync(dayFile, JSON.stringify({ day: day, kwh: kwh })); } catch (e) { /* nicht kritisch */ }
  }
  function integrate(st, w, now) {
    const d = today();
    if (d !== day) { day = d; S.forEach(function (x) { x.kwh = 0; }); }
    if (st.at && now - st.at < 10 * 60000 && st.watts !== null) st.kwh += Math.max(0, (st.watts + w) / 2) * (now - st.at) / 3600000 / 1000;
  }

  function poll(st) {
    if (stopped) return;
    readOne(st.cfg, pool, ctx.timeoutMs).then(function (v) {
      const w = Math.round(v * (st.cfg.invert ? -1 : 1)), now = Date.now();
      if (st.error) log('Messgerät ' + st.cfg.name + ' wird wieder gelesen');
      integrate(st, w, now);
      st.watts = w; st.at = now; st.error = null;
      saveDay(false);
    }, function (e) {
      if (st.error !== e.message) log('Messgerät ' + st.cfg.name + ': ' + e.message);
      st.error = e.message;
    }).then(function () { if (!stopped) st.timer = setTimeout(function () { poll(st); }, Math.max(5, st.cfg.pollSeconds || 10) * 1000); });
  }

  function byRole(role) { return S.filter(function (st) { return st.cfg.role === role && st.watts !== null && Date.now() - st.at < 5 * 60000; }); }
  function sumRole(role) { const l = byRole(role); return l.length ? l.reduce(function (a, st) { return a + st.watts; }, 0) : null; }
  function kwhRole(role) { if (today() !== day) return 0; return S.filter(function (st) { return st.cfg.role === role; }).reduce(function (a, st) { return a + st.kwh; }, 0); }

  return {
    start: function () { S.forEach(function (st, i) { setTimeout(function () { poll(st); }, 500 + i * 300); }); if (S.length) log('Messgeräte: ' + S.map(function (st) { return st.cfg.name + ' (' + ROLES[st.cfg.role] + ', ' + st.cfg.source + ')'; }).join(', ')); },
    stop: function () { stopped = true; S.forEach(function (st) { if (st.timer) clearTimeout(st.timer); }); Object.keys(pool).forEach(function (k) { pool[k].close(); }); saveDay(true); },
    sumRole: sumRole,
    kwhRole: kwhRole,
    state: function () {
      return S.map(function (st) { return { name: st.cfg.name, role: st.cfg.role, roleLabel: ROLES[st.cfg.role] || st.cfg.role, source: st.cfg.source, watts: st.watts, at: st.at, kwhToday: Math.round(st.kwh * 100) / 100, fresh: st.watts !== null && Date.now() - st.at < 5 * 60000, error: st.error }; });
    }
  };
};
module.exports.test = function (m, timeoutMs) {
  const pool = {};
  return readOne(m, pool, timeoutMs).then(function (v) { Object.keys(pool).forEach(function (k) { pool[k].close(); }); return { ok: true, watts: Math.round(v * (m.invert ? -1 : 1)), raw: v }; },
    function (e) { Object.keys(pool).forEach(function (k) { pool[k].close(); }); throw e; });
};
module.exports.TEMPLATES = TEMPLATES;
module.exports.ROLES = ROLES;
module.exports.TYPES = Object.keys(TYPES);
module.exports.fromDocNo = function (n) { n = Number(n); if (!Number.isInteger(n)) return null; if (n >= 30001 && n <= 39999) return { fc: 4, addr: n - 30001 }; if (n >= 40001 && n <= 49999) return { fc: 3, addr: n - 40001 }; if (n >= 0 && n <= 65535) return { fc: 4, addr: n }; return null; };
