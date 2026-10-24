'use strict';
/*
 * Sungrow Steuerung – (C) by Elric M.
 * Nur für die private Nutzung zu Test- und Lernzwecken. Kommerzielle Verwendung jeder Art, die Verwendung im
 * Geschäftsbetrieb und der Weiterverkauf sind untersagt. Benutzung auf eigene Gefahr, ohne Gewährleistung oder Garantie.
 * Einzelheiten: LICENSE und HANDBUCH.md.
 */
/*
 * Seite „Anlage“: Einrichtung über den Browser.
 *
 * Hier werden Wechselrichter, Register, WiNet-S und Batterie eingestellt und in config.json geschrieben. Weil dabei
 * IP-Adressen und das WiNet-Passwort berührt werden, ist die Seite mit einem eigenen Passwort geschützt. Das Passwort wird
 * nur als scrypt-Hash in config.json abgelegt (Abschnitt "admin"). Wer es vergessen hat, löscht diesen Abschnitt in
 * config.json und startet neu: dann wird beim nächsten Aufruf ein neues Passwort festgelegt.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const R = require('./registers');
const HP = require('./heatpump');
const PL = require('./planner');
const MT = require('./meters');

module.exports = function (ctx) {
const ROOT = ctx.root, CONFIG = ctx.configFile || path.join(ROOT, 'config.json');
const COOKIE = 'sg_anlage';
let failures = 0, blockedUntil = 0;

function readFileConfig() { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch (e) { return {}; } }
function writeFileConfig(c) {
  try { if (fs.existsSync(CONFIG)) fs.copyFileSync(CONFIG, CONFIG + '.bak'); } catch (e) { /* Sicherung ist nur ein Komfort */ }
  const tmp = CONFIG + '.neu';
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, CONFIG);
}

/* ---------------------------------------------------------------- Passwort und Sitzung */

function admin() { return readFileConfig().admin || null; }
function hash(pw, salt) { return crypto.scryptSync(String(pw), Buffer.from(salt, 'hex'), 32).toString('hex'); }
function checkPassword(pw) {
  const a = admin(); if (!a || !a.hash || !a.salt) return false;
  const x = Buffer.from(hash(pw, a.salt), 'hex'), y = Buffer.from(a.hash, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function setPassword(pw) {
  const c = readFileConfig(), salt = crypto.randomBytes(16).toString('hex');
  c.admin = { salt: salt, hash: hash(pw, salt), secret: crypto.randomBytes(32).toString('hex') };
  writeFileConfig(c);
}
/* Sitzungsschlüssel: Ablaufzeit plus HMAC mit dem Geheimnis aus config.json. Übersteht einen Neustart nach dem Speichern. */
function makeToken() {
  const a = admin(), exp = Date.now() + 12 * 3600000;
  return exp + '.' + crypto.createHmac('sha256', a.secret).update(String(exp)).digest('hex');
}
function cookieValue(req) {
  const m = new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)').exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : null;
}
function loggedIn(req) {
  const a = admin(), t = cookieValue(req); if (!a || !a.secret || !t) return false;
  const p = t.split('.'); if (p.length !== 2 || !(+p[0] > Date.now())) return false;
  const want = crypto.createHmac('sha256', a.secret).update(p[0]).digest('hex');
  return want.length === p[1].length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(p[1]));
}
function setCookie(res, value) {
  res.setHeader('Set-Cookie', COOKIE + '=' + encodeURIComponent(value) + '; Path=/; HttpOnly; SameSite=Strict' + (value ? '; Max-Age=43200' : '; Max-Age=0'));
}

/* ---------------------------------------------------------------- Konfiguration für die Seite */

const MAX_MODULES = 8;   // der Zellblock des SBR enthält Plätze für 8 Module

function publicConfig() {
  const c = ctx.cfg, f = readFileConfig();
  const invs = R.normalizeInverters(f).map(function (i) {
    return { name: i.name || '', enabled: i.enabled !== false, type: i.type === 'string' ? 'string' : 'hybrid', host: i.host || '', port: i.port || 502, unitId: i.unitId || 1,
      ratedPower: i.ratedPower || 10600, addToHouseLoad: i.type === 'string' ? i.addToHouseLoad !== false : undefined, registers: i.registers || {} };
  });
  return {
    plantName: c.plantName, httpPort: c.http.port, pollSeconds: c.pollSeconds,
    inverters: invs,
    cellSource: c.winet.enabled ? 'winet' : c.battery.enabled ? 'modbus' : 'off',
    winet: { host: c.winet.host || '', port: c.winet.port, username: c.winet.username || '', passwordSet: !!c.winet.password,
      intervalSeconds: c.winet.intervalSeconds, paramAddress: c.winet.paramAddress, paramCount: c.winet.paramCount },
    modbusBattery: { host: c.battery.host || '', port: c.battery.port || 502, unitId: c.battery.unitId, cellBlockAddress: c.battery.cellBlockAddress },
    moduleCount: c.moduleCount, topModuleIndex: c.topModuleIndex, moduleNotes: c.moduleNotes || {},
    targetModule: (c.matching && c.matching.targetModule) || c.moduleCount,
    meters: (Array.isArray(c.meters) ? c.meters : []).map(function (m) { return Object.assign({}, m, { password: undefined, passwordSet: !!m.password }); }),
    heatpump: heatpumpPublic(c.heatpump || {}),
    prices: Object.assign({ exchange: 'none', fixedCt: 18, vatPercent: 19, feedInCt: 8, fallbackCt: 30, zone: 'DE-LU', url: '' }, c.prices || {}),
    forecast: { provider: (c.forecast && c.forecast.provider) || 'openmeteo', lat: c.forecast && c.forecast.lat !== null ? c.forecast.lat : '', lon: c.forecast && c.forecast.lon !== null ? c.forecast.lon : '',
      planes: (c.forecast && Array.isArray(c.forecast.planes) ? c.forecast.planes : []).map(function (p) { return { name: p.name || '', kwp: p.kwp, azimuth: p.azimuth, tilt: p.tilt }; }),
      performanceRatio: (c.forecast && c.forecast.performanceRatio) || 0.85, urlWeather: (c.forecast && c.forecast.urlWeather) || '', urlSolar: (c.forecast && c.forecast.urlSolar) || '' },
    planner: plannerPublic(c.planner || {})
  };
}
function heatpumpPublic(h) {
  const map = HP.mapFor(h);
  return { enabled: !!h.enabled, name: h.name || 'Wärmepumpe', model: h.model || 'weishaupt', host: h.host || '', port: h.port || 502, unitId: h.unitId === undefined ? 1 : h.unitId,
    framing: h.framing === 'tcp' ? 'tcp' : 'rtu', pollSeconds: h.pollSeconds || 30, writeEnabled: !!h.writeEnabled, shift: { min: h.shift && typeof h.shift.min === 'number' ? h.shift.min : -3, max: h.shift && typeof h.shift.max === 'number' ? h.shift.max : 5 },
    registers: map.map(function (e) { return { key: e.key, group: e.group, label: e.label, doc: e.doc, fc: e.fc, addr: e.addr, type: e.type, scale: e.scale, unit: e.unit, on: e.on, writable: e.writable, verified: e.verified, custom: e.custom }; }) };
}
function plannerPublic(p) {
  const d = PL.DEFAULTS, out = {};
  Object.keys(d).forEach(function (k) { if (k !== 'heat') out[k] = p[k] === undefined ? d[k] : p[k]; });
  out.heat = Object.assign({}, d.heat, p.heat || {});
  return out;
}
function heatpumpDefaults() { return HP.mapFor({}); }
function typeInfo() {
  const out = {};
  Object.keys(R.TYPES).forEach(function (k) { out[k] = { label: R.TYPES[k].label, map: R.TYPES[k].map.map(function (e) { return { key: e.key, group: e.group, label: e.label, fc: e.fc, addr: e.addr, type: e.type, scale: e.scale, unit: e.unit, core: !!e.core }; }) }; });
  return out;
}

/* ---------------------------------------------------------------- Prüfen und Speichern */

const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
function int(v, lo, hi) { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : null; }
function cleanHost(v) { const s = String(v || '').trim(); return s && s.length <= 253 && HOST_RE.test(s) ? s : null; }

function validate(body) {
  const err = [], b = body || {};
  const plantName = String(b.plantName || '').trim().slice(0, 80) || 'Meine Anlage';
  const httpPort = int(b.httpPort, 1024, 65535); if (httpPort === null) err.push('Port der Weboberfläche: 1024 bis 65535');
  const pollSeconds = int(b.pollSeconds, 5, 300); if (pollSeconds === null) err.push('Messintervall: 5 bis 300 Sekunden');
  const names = {};
  const invs = (Array.isArray(b.inverters) ? b.inverters : []).slice(0, 12).map(function (i, n) {
    const tag = 'Wechselrichter ' + (n + 1), type = i.type === 'string' ? 'string' : 'hybrid';
    const name = String(i.name || '').trim().slice(0, 40);
    if (!name) err.push(tag + ': Name fehlt');
    else if (names[name.toLowerCase()]) err.push(tag + ': Name „' + name + '“ ist doppelt'); else names[name.toLowerCase()] = true;
    const host = cleanHost(i.host); if (!host) err.push((name || tag) + ': IP-Adresse oder Hostname fehlt oder ist ungültig');
    const port = int(i.port, 1, 65535); if (port === null) err.push((name || tag) + ': Port 1 bis 65535');
    const unitId = int(i.unitId, 0, 247); if (unitId === null) err.push((name || tag) + ': Geräteadresse 0 bis 247');
    const out = { name: name, enabled: i.enabled !== false, type: type, host: host || '', port: port || 502, unitId: unitId === null ? 1 : unitId, registers: {} };
    if (type === 'hybrid') { const rp = int(i.ratedPower, 1000, 50000); if (rp === null) err.push((name || tag) + ': Nennleistung 1000 bis 50000 W'); out.ratedPower = rp || 10600; }
    else out.addToHouseLoad = i.addToHouseLoad !== false;
    const defs = R.TYPES[type].map, regs = i.registers || {};
    defs.forEach(function (d) {
      if (regs[d.key] === undefined || regs[d.key] === '' || regs[d.key] === null) return;
      const a = int(regs[d.key], 0, 65535);
      if (a === null) err.push((name || tag) + ': Register „' + d.label + '“ braucht eine Adresse von 0 bis 65535');
      else if (a !== d.addr) out.registers[d.key] = a;      // gespeichert werden nur Abweichungen von der Standardkarte
    });
    return out;
  });
  const hybrids = invs.filter(function (i) { return i.type === 'hybrid' && i.enabled; });
  if (hybrids.length !== 1) err.push(hybrids.length ? 'Es darf nur ein Hybridwechselrichter aktiv sein: er führt Batterie, Einstellungen und Matching.' : 'Es braucht genau einen aktiven Hybridwechselrichter mit Batterie.');
  const src = ['winet', 'modbus', 'off'].indexOf(b.cellSource) >= 0 ? b.cellSource : 'winet';
  const w = b.winet || {};
  const winet = {
    host: w.host ? cleanHost(w.host) : null, port: int(w.port, 1, 65535), username: String(w.username || '').trim().slice(0, 64),
    password: typeof w.password === 'string' ? w.password : '', intervalSeconds: int(w.intervalSeconds, 10, 600),
    paramAddress: int(w.paramAddress, 0, 65535), paramCount: int(w.paramCount, 24, 60)
  };
  if (w.host && !winet.host) err.push('WiNet-S: Adresse ungültig');
  if (src === 'winet') {
    if (winet.port === null) err.push('WiNet-S: Port 1 bis 65535');
    if (!winet.username) err.push('WiNet-S: Benutzer fehlt');
    if (winet.intervalSeconds === null) err.push('WiNet-S: Abfrageintervall 10 bis 600 Sekunden');
    if (winet.paramAddress === null || winet.paramCount === null) err.push('WiNet-S: Zellblock-Adresse 0 bis 65535, Anzahl 24 bis 60');
  }
  const mb = b.modbusBattery || {};
  const modbusBattery = { host: mb.host ? cleanHost(mb.host) : null, port: int(mb.port, 1, 65535), unitId: int(mb.unitId, 0, 247), cellBlockAddress: int(mb.cellBlockAddress, 0, 65535) };
  if (mb.host && !modbusBattery.host) err.push('Batterie über Modbus: Adresse ungültig');
  if (src === 'modbus' && (modbusBattery.unitId === null || modbusBattery.cellBlockAddress === null || modbusBattery.port === null)) err.push('Batterie über Modbus: Adresse, Port, Geräteadresse und Zellblock-Adresse prüfen');
  const moduleCount = int(b.moduleCount, 1, MAX_MODULES); if (moduleCount === null) err.push('Anzahl der Module: 1 bis ' + MAX_MODULES);
  const top = int(b.topModuleIndex, 1, MAX_MODULES); if (top === null || (moduleCount && top > moduleCount)) err.push('Oberstes Modul: 1 bis Anzahl der Module');
  const target = int(b.targetModule, 1, MAX_MODULES); if (target === null || (moduleCount && target > moduleCount)) err.push('Nachgerüstetes Modul: 1 bis Anzahl der Module');
  const notes = {};
  Object.keys(b.moduleNotes || {}).forEach(function (k) { const n = int(k, 1, MAX_MODULES), t = String(b.moduleNotes[k] || '').trim().slice(0, 40); if (n && t && (!moduleCount || n <= moduleCount)) notes[n] = t; });
  const mtv = validateMeters(b.meters || [], err), hpv = validateHeatpump(b.heatpump || {}, err), prv = validatePrices(b.prices || {}, err), fcv = validateForecast(b.forecast || {}, err), plv = validatePlanner(b.planner || {}, err);
  if (plv.heat.enabled && !hpv.enabled) err.push('Planer: die Wärmepumpe soll geplant werden, ist aber nicht aktiv.');
  if (plv.mode === 'active' && plv.heat.enabled && !hpv.writeEnabled) err.push('Planer: im aktiven Modus mit Wärmepumpe muss bei der Wärmepumpe „Schreiben erlauben“ gesetzt sein.');
  return { errors: err, value: { plantName: plantName, httpPort: httpPort, pollSeconds: pollSeconds, inverters: invs, cellSource: src, winet: winet, modbusBattery: modbusBattery,
    moduleCount: moduleCount, topModuleIndex: top, targetModule: target, moduleNotes: notes, meters: mtv, heatpump: hpv, prices: prv, forecast: fcv, planner: plv } };
}
function validateMeters(list, err) {
  const out = [], names = {};
  (Array.isArray(list) ? list : []).slice(0, 12).forEach(function (m, n) {
    const tag = 'Messgerät ' + (n + 1), name = String(m.name || '').trim().slice(0, 40);
    if (!name) { err.push(tag + ': Name fehlt'); return; }
    if (names[name.toLowerCase()]) err.push(tag + ': Name „' + name + '“ ist doppelt'); names[name.toLowerCase()] = true;
    const o = { name: name, enabled: m.enabled !== false, role: MT.ROLES[m.role] ? m.role : 'custom', source: ['modbus', 'loxone', 'http'].indexOf(m.source) >= 0 ? m.source : 'modbus',
      pollSeconds: int(m.pollSeconds, 5, 600) || 10, scale: num(m.scale, -1000000, 1000000), invert: !!m.invert };
    if (o.scale === null || o.scale === 0) o.scale = 1;
    if (o.source === 'modbus') {
      o.host = cleanHost(m.host); if (!o.host) err.push(name + ': IP-Adresse fehlt oder ist ungültig');
      o.port = int(m.port, 1, 65535) || 502; o.unitId = int(m.unitId, 0, 247); if (o.unitId === null) o.unitId = 1;
      o.framing = m.framing === 'tcp' ? 'tcp' : 'rtu'; o.template = String(m.template || 'generic').slice(0, 20);
      const fa = MT.fromDocNo(m.doc); if (!fa) err.push(name + ': Doku-Nr. 30001–39999 (Input) oder 40001–49999 (Holding)'); else { o.fc = fa.fc; o.addr = fa.addr; o.doc = Number(m.doc); }
      o.type = MT.TYPES.indexOf(m.type) >= 0 ? m.type : 'u16';
    } else if (o.source === 'loxone') {
      o.host = cleanHost(m.host); if (!o.host) err.push(name + ': Adresse des Miniservers fehlt oder ist ungültig');
      o.port = int(m.port, 1, 65535) || 80; o.username = String(m.username || '').trim().slice(0, 64); o.password = typeof m.password === 'string' ? m.password : '';
      o.object = String(m.object || '').trim().slice(0, 80); if (!o.object) err.push(name + ': Objektname aus Loxone Config fehlt');
      if (!o.username) err.push(name + ': Benutzer für den Miniserver fehlt');
    } else {
      o.url = String(m.url || '').trim().slice(0, 300); if (!/^https?:\/\//.test(o.url)) err.push(name + ': Adresse muss mit http:// oder https:// beginnen');
      o.path = String(m.path || '').trim().slice(0, 120); o.username = String(m.username || '').trim().slice(0, 64); o.password = typeof m.password === 'string' ? m.password : '';
    }
    out.push(o);
  });
  return out;
}
function num(v, lo, hi) { const n = Number(v); return typeof v !== 'boolean' && v !== '' && v !== null && v !== undefined && !isNaN(n) && n >= lo && n <= hi ? n : null; }
function validateHeatpump(h, err) {
  const out = { enabled: !!h.enabled, name: String(h.name || '').trim().slice(0, 40) || 'Wärmepumpe', model: 'weishaupt', host: '', port: 502, unitId: 1, framing: h.framing === 'tcp' ? 'tcp' : 'rtu',
    pollSeconds: 30, writeEnabled: !!h.writeEnabled, shift: { min: -3, max: 5 }, registers: {} };
  const tag = 'Wärmepumpe';
  if (out.enabled) {
    const host = cleanHost(h.host); if (!host) err.push(tag + ': IP-Adresse oder Hostname des Umsetzers fehlt oder ist ungültig'); out.host = host || '';
    const port = int(h.port, 1, 65535); if (port === null) err.push(tag + ': Port 1 bis 65535'); out.port = port || 502;
    const unit = int(h.unitId, 0, 247); if (unit === null) err.push(tag + ': Geräteadresse 0 bis 247'); out.unitId = unit === null ? 1 : unit;
    const ps = int(h.pollSeconds, 5, 600); if (ps === null) err.push(tag + ': Abfrage alle 5 bis 600 Sekunden'); out.pollSeconds = ps || 30;
  } else { out.host = cleanHost(h.host) || ''; out.port = int(h.port, 1, 65535) || 502; out.unitId = int(h.unitId, 0, 247); if (out.unitId === null) out.unitId = 1; out.pollSeconds = int(h.pollSeconds, 5, 600) || 30; }
  const sh = h.shift || {};
  const mn = num(sh.min, -10, 0), mx = num(sh.max, 0, 15);
  if (mn === null || mx === null) err.push(tag + ': Verschiebung mindestens −10 bis 0 K, höchstens 0 bis 15 K'); else { out.shift.min = mn; out.shift.max = mx; }
  const defs = heatpumpDefaults(), regs = Array.isArray(h.registers) ? h.registers : [];
  defs.forEach(function (d) {
    const rI = regs.filter(function (x) { return x && x.key === d.key; })[0]; if (!rI) return;
    const o = {};
    if (rI.doc !== undefined && rI.doc !== '') { const fa = HP.fromDocNo(rI.doc); if (!fa) err.push(tag + ': Register „' + d.label + '“ braucht eine Doku-Nr. 30001–39999 (Input) oder 40001–49999 (Holding)'); else { o.fc = fa.fc; o.addr = fa.addr; } }
    if (rI.type === 'u16' || rI.type === 's16') o.type = rI.type;
    const sc = num(rI.scale, 0.0001, 1000); if (rI.scale !== undefined && rI.scale !== '') { if (sc === null) err.push(tag + ': Faktor bei „' + d.label + '“ ungültig'); else o.scale = sc; }
    if (typeof rI.on === 'boolean') o.on = rI.on;
    if (d.writable && o.on === false) o.on = true;        // die Verschiebung bleibt immer in der Karte
    const diff = {};
    if (o.fc !== undefined && (o.fc !== d.fc || o.addr !== d.addr)) { diff.fc = o.fc; diff.addr = o.addr; }
    if (o.type !== undefined && o.type !== d.type) diff.type = o.type;
    if (o.scale !== undefined && o.scale !== d.scale) diff.scale = o.scale;
    if (o.on !== undefined && o.on !== d.on) diff.on = o.on;
    if (Object.keys(diff).length) out.registers[d.key] = diff;
  });
  return out;
}
function validatePrices(p, err) {
  const out = { exchange: ['awattar', 'energycharts', 'none'].indexOf(p.exchange) >= 0 ? p.exchange : 'none', zone: String(p.zone || 'DE-LU').trim().slice(0, 10), url: String(p.url || '').trim().slice(0, 300) };
  const f = function (k, lo, hi, label, def) { const v = num(p[k], lo, hi); if (v === null) { if (p[k] === '' || p[k] === undefined) return def; err.push('Strompreis: ' + label); return def; } return v; };
  out.fixedCt = f('fixedCt', 0, 100, 'feste Bestandteile 0 bis 100 ct/kWh', 18);
  out.vatPercent = f('vatPercent', 0, 30, 'Mehrwertsteuer 0 bis 30 %', 19);
  out.feedInCt = f('feedInCt', 0, 100, 'Einspeisevergütung 0 bis 100 ct/kWh', 8);
  out.fallbackCt = f('fallbackCt', 0, 200, 'Ersatzpreis 0 bis 200 ct/kWh', 30);
  if (out.url && !/^https?:\/\//.test(out.url)) err.push('Strompreis: die Adresse der Schnittstelle muss mit http:// oder https:// beginnen');
  return out;
}
function validateForecast(fv, err) {
  const out = { provider: fv.provider === 'forecastsolar' ? 'forecastsolar' : 'openmeteo', lat: num(fv.lat, -90, 90), lon: num(fv.lon, -180, 180), planes: [], performanceRatio: num(fv.performanceRatio, 0.3, 1.2), urlWeather: String(fv.urlWeather || '').trim().slice(0, 300), urlSolar: String(fv.urlSolar || '').trim().slice(0, 300) };
  if (out.performanceRatio === null) out.performanceRatio = 0.85;
  const planes = Array.isArray(fv.planes) ? fv.planes.slice(0, 6) : [];
  planes.forEach(function (pl, i) {
    const tag = 'Prognose, Dachfläche ' + (i + 1);
    const kwp = num(pl.kwp, 0.1, 200), az = num(pl.azimuth, -180, 180), tilt = num(pl.tilt, 0, 90);
    if (kwp === null) err.push(tag + ': Leistung 0,1 bis 200 kWp'); if (az === null) err.push(tag + ': Ausrichtung −180 bis 180° (0 = Süd, −90 = Ost, 90 = West)'); if (tilt === null) err.push(tag + ': Neigung 0 bis 90°');
    out.planes.push({ name: String(pl.name || '').trim().slice(0, 30), kwp: kwp || 1, azimuth: az || 0, tilt: tilt === null ? 30 : tilt });
  });
  if (planes.length && (out.lat === null || out.lon === null)) err.push('Prognose: Breiten- und Längengrad des Standorts fehlen (Dezimalgrad, z. B. 50.11 und 8.68)');
  [out.urlWeather, out.urlSolar].forEach(function (u) { if (u && !/^https?:\/\//.test(u)) err.push('Prognose: Adressen der Schnittstellen müssen mit http:// oder https:// beginnen'); });
  return out;
}
function validatePlanner(p, err) {
  const d = PL.DEFAULTS, out = {};
  out.mode = ['off', 'simulate', 'active'].indexOf(p.mode) >= 0 ? p.mode : 'off';
  const f = function (o, src, k, lo, hi, label, def) { const v = num(src[k], lo, hi); if (v === null) { if (src[k] === '' || src[k] === undefined) { o[k] = def; return; } err.push('Planer: ' + label); o[k] = def; } else o[k] = v; };
  f(out, p, 'horizonHours', 12, 72, 'Planungshorizont 12 bis 72 Stunden', d.horizonHours);
  f(out, p, 'capacityKwh', 0, 500, 'Kapazität 0 (= vom Wechselrichter) bis 500 kWh', d.capacityKwh);
  f(out, p, 'minSoc', 0, 90, 'untere Ladegrenze 0 bis 90 %', d.minSoc);
  f(out, p, 'maxSoc', 20, 100, 'obere Ladegrenze 20 bis 100 %', d.maxSoc);
  f(out, p, 'chargeW', 100, 50000, 'Netzladeleistung 100 bis 50000 W', d.chargeW);
  f(out, p, 'dischargeW', 100, 50000, 'Entladeleistung 100 bis 50000 W', d.dischargeW);
  f(out, p, 'pvChargeW', 100, 50000, 'PV-Ladeleistung 100 bis 50000 W', d.pvChargeW);
  f(out, p, 'efficiency', 0.5, 1, 'Wirkungsgrad 0,5 bis 1', d.efficiency);
  f(out, p, 'marginCt', 0, 30, 'Mindestvorteil 0 bis 30 ct/kWh', d.marginCt);
  f(out, p, 'baseLoadW', 0, 20000, 'Grundlast 0 bis 20000 W', d.baseLoadW);
  f(out, p, 'tickSeconds', 10, 600, 'Takt 10 bis 600 Sekunden', d.tickSeconds);
  if (out.minSoc >= out.maxSoc) err.push('Planer: die untere Ladegrenze muss unter der oberen liegen');
  const h = p.heat || {}, oh = {}; out.heat = oh;
  oh.enabled = !!h.enabled;
  f(oh, h, 'limitTemp', -5, 25, 'Heizgrenze −5 bis 25 °C', d.heat.limitTemp);
  f(oh, h, 'wattsPerKelvin', 10, 2000, 'Leistung je Kelvin 10 bis 2000 W', d.heat.wattsPerKelvin);
  f(oh, h, 'kwPerShiftK', 0.01, 5, 'Mehrleistung je Kelvin Verschiebung 0,01 bis 5 kW', d.heat.kwPerShiftK);
  f(oh, h, 'storeHours', 0.5, 12, 'Speicherdauer 0,5 bis 12 Stunden', d.heat.storeHours);
  f(oh, h, 'shiftUp', 0, 15, 'Anhebung 0 bis 15 K', d.heat.shiftUp);
  f(oh, h, 'shiftDown', -10, 0, 'Absenkung −10 bis 0 K', d.heat.shiftDown);
  f(oh, h, 'surplusW', 0, 30000, 'Überschuss-Schwelle 0 bis 30000 W', d.heat.surplusW);
  f(oh, h, 'cheapPct', 5, 50, 'Anteil billige Stunden 5 bis 50 %', d.heat.cheapPct);
  f(oh, h, 'expensivePct', 5, 50, 'Anteil teure Stunden 5 bis 50 %', d.heat.expensivePct);
  return out;
}

function save(v) {
  const c = readFileConfig();
  delete c.inverter; delete c.inverter2;
  c.plantName = v.plantName;
  c.http = Object.assign({}, c.http, { port: v.httpPort });
  c.pollSeconds = v.pollSeconds;
  c.inverters = v.inverters;
  const old = c.winet || {};
  c.winet = Object.assign({}, old, {
    enabled: v.cellSource === 'winet', host: v.winet.host, port: v.winet.port || old.port || 443, username: v.winet.username,
    password: v.winet.password ? v.winet.password : (old.password || ''),
    intervalSeconds: v.winet.intervalSeconds || old.intervalSeconds || 30,
    paramAddress: v.winet.paramAddress === null ? 10756 : v.winet.paramAddress, paramCount: v.winet.paramCount || 30
  });
  ['devId', 'devType', 'devCode'].forEach(function (k) { if (v.winet.host !== (old.host || null)) delete c.winet[k]; });
  c.battery = Object.assign({}, c.battery, { enabled: v.cellSource === 'modbus', host: v.modbusBattery.host, port: v.modbusBattery.port || 502, unitId: v.modbusBattery.unitId === null ? 200 : v.modbusBattery.unitId,
    cellBlockAddress: v.modbusBattery.cellBlockAddress === null ? 10756 : v.modbusBattery.cellBlockAddress });
  c.moduleCount = v.moduleCount; c.topModuleIndex = v.topModuleIndex; c.moduleNotes = v.moduleNotes;
  c.matching = Object.assign({}, c.matching, { targetModule: v.targetModule });
  // Passwörter der Messgeräte: leeres Feld behält das gespeicherte
  const oldM = Array.isArray(c.meters) ? c.meters : [];
  v.meters.forEach(function (m) { if (m.password === '' ) { const o = oldM.filter(function (x) { return x.name === m.name; })[0]; if (o && o.password) m.password = o.password; } });
  c.meters = v.meters; c.heatpump = v.heatpump; c.prices = v.prices; c.forecast = v.forecast; c.planner = v.planner;
  writeFileConfig(c);
}
/* Betriebsart des Planers von der Seite Planer aus umschalten, ohne Neustart */
function setPlannerMode(mode) {
  const c = readFileConfig();
  c.planner = Object.assign({}, c.planner, { mode: mode });
  writeFileConfig(c);
  if (ctx.cfg.planner) ctx.cfg.planner.mode = mode;
}

/* ---------------------------------------------------------------- HTTP */

function sendJson(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
function readBody(req, limit, cb) {
  let body = '', over = false;
  req.on('data', function (c) { body += c; if (body.length > limit) { over = true; req.destroy(); } });
  req.on('end', function () { if (over) return; let j = {}; try { j = JSON.parse(body); } catch (e) { /* leer */ } cb(j); });
}

/* liefert true, wenn die Anfrage hier beantwortet wurde */
function handle(req, res, url) {
  if (url.pathname.indexOf('/api/setup/') !== 0) return false;
  const what = url.pathname.slice(11), post = req.method === 'POST';
  // Schreibende Anfragen nur mit eigener Kopfzeile: ein fremdes Formular oder eine fremde Seite kann sie nicht mitschicken
  if (post && req.headers['x-requested-with'] !== 'sungrow') { sendJson(res, 403, { error: 'Anfrage abgelehnt' }); return true; }
  const a = admin();

  if (what === 'status') { sendJson(res, 200, { configured: ctx.configured(), passwordSet: !!(a && a.hash), loggedIn: loggedIn(req), port: ctx.cfg.http.port }); return true; }

  if (what === 'password' && post) {
    readBody(req, 2000, function (j) {
      if (a && a.hash && !loggedIn(req)) return sendJson(res, 403, { error: 'Bitte zuerst anmelden.' });
      if (a && a.hash && !checkPassword(j.old || '')) return sendJson(res, 403, { error: 'Das bisherige Passwort stimmt nicht.' });
      if (typeof j.password !== 'string' || j.password.length < 8) return sendJson(res, 400, { error: 'Das Passwort braucht mindestens 8 Zeichen.' });
      setPassword(j.password); setCookie(res, makeToken());
      console.log(new Date().toLocaleString('de-DE') + ' Seite Anlage: Passwort ' + (a && a.hash ? 'geändert' : 'festgelegt'));
      sendJson(res, 200, { ok: true });
    });
    return true;
  }
  if (what === 'login' && post) {
    readBody(req, 2000, function (j) {
      if (Date.now() < blockedUntil) return sendJson(res, 429, { error: 'Zu viele Fehlversuche. Bitte ' + Math.ceil((blockedUntil - Date.now()) / 1000) + ' Sekunden warten.' });
      if (!checkPassword(j.password || '')) {
        failures++; if (failures >= 5) { blockedUntil = Date.now() + 30000 * Math.min(10, failures - 4); }
        return setTimeout(function () { sendJson(res, 403, { error: 'Passwort falsch.' }); }, 600);
      }
      failures = 0; setCookie(res, makeToken()); sendJson(res, 200, { ok: true });
    });
    return true;
  }
  if (what === 'logout' && post) { setCookie(res, ''); sendJson(res, 200, { ok: true }); return true; }

  if (!loggedIn(req)) { sendJson(res, 401, { error: 'Nicht angemeldet.' }); return true; }

  if (what === 'config') { sendJson(res, 200, { config: publicConfig(), types: typeInfo(), maxModules: MAX_MODULES, meterTemplates: MT.TEMPLATES, meterRoles: MT.ROLES, meterTypes: MT.TYPES, heatpumpTypes: Object.keys(HP.TYPES).map(function (k) { return { id: k, label: HP.TYPES[k].label }; }), heatpumpDefaults: heatpumpDefaults().map(function (e) { return { key: e.key, doc: e.doc, type: e.type, scale: e.scale, on: e.on }; }), plannerDefaults: PL.DEFAULTS }); return true; }

  if (what === 'test' && post) {
    readBody(req, 50000, function (j) {
      const i = j.inverter || {}, host = cleanHost(i.host), port = int(i.port, 1, 65535), unitId = int(i.unitId, 0, 247);
      if (!host || port === null || unitId === null) return sendJson(res, 200, { ok: false, error: 'Adresse, Port oder Geräteadresse ungültig.' });
      const regs = {}; Object.keys(i.registers || {}).forEach(function (k) { const n = int(i.registers[k], 0, 65535); if (n !== null) regs[k] = n; });
      const inv = { type: i.type === 'string' ? 'string' : 'hybrid', host: host, port: port, unitId: unitId, registers: regs };
      ctx.testInverter(inv).then(function (r) { sendJson(res, 200, r); }, function (e) { sendJson(res, 200, { ok: false, error: e.message }); });
    });
    return true;
  }
  if (what === 'test-winet' && post) {
    readBody(req, 5000, function (j) {
      const w = j.winet || {}, host = cleanHost(w.host) || cleanHost(j.inverterHost), port = int(w.port, 1, 65535);
      if (!host || port === null) return sendJson(res, 200, { ok: false, error: 'Adresse oder Port des WiNet-S ungültig.' });
      const password = w.password || (ctx.cfg.winet && ctx.cfg.winet.password) || '';
      if (!w.username || !password) return sendJson(res, 200, { ok: false, error: 'Benutzer und Passwort der WiNet-S-Weboberfläche eintragen.' });
      ctx.testWinet({ host: host, port: port, username: String(w.username), password: password, paramAddress: int(w.paramAddress, 0, 65535) || 10756, paramCount: int(w.paramCount, 24, 60) || 30 })
        .then(function (r) { sendJson(res, 200, r); }, function (e) { sendJson(res, 200, { ok: false, error: e.message }); });
    });
    return true;
  }
  if (what === 'test-meter' && post) {
    readBody(req, 10000, function (j) {
      const e2 = [], l = validateMeters([Object.assign({}, j.meter || {}, { name: (j.meter && j.meter.name) || 'Test' })], e2);
      if (e2.length) return sendJson(res, 200, { ok: false, error: e2.join('; ') });
      const m = l[0];
      if (m.password === '') { const o = (Array.isArray(ctx.cfg.meters) ? ctx.cfg.meters : []).filter(function (x) { return x.name === m.name; })[0]; if (o && o.password) m.password = o.password; }
      MT.test(m, ctx.cfg.timeoutMs).then(function (r) { sendJson(res, 200, r); }, function (e) { sendJson(res, 200, { ok: false, error: e.message }); });
    });
    return true;
  }
  if (what === 'test-heatpump' && post) {
    readBody(req, 50000, function (j) {
      const e2 = [], h = validateHeatpump(Object.assign({}, j.heatpump || {}, { enabled: true }), e2);
      if (e2.length) return sendJson(res, 200, { ok: false, error: e2.join('; ') });
      HP.test(h, ctx.cfg.timeoutMs).then(function (r) { sendJson(res, 200, r); }, function (e) { sendJson(res, 200, { ok: false, error: e.message }); });
    });
    return true;
  }
  if (what === 'test-prices' && post) {
    readBody(req, 5000, function (j) {
      const e2 = [], p = validatePrices(j.prices || {}, e2);
      if (e2.length) return sendJson(res, 200, { ok: false, error: e2.join('; ') });
      if (p.exchange === 'none') return sendJson(res, 200, { ok: true, fixed: true, now: { buy: (p.fallbackCt) } });
      require('./prices').test(p).then(function (r) { sendJson(res, 200, r); }, function (e) { sendJson(res, 200, { ok: false, error: e.message }); });
    });
    return true;
  }
  if (what === 'test-forecast' && post) {
    readBody(req, 10000, function (j) {
      const e2 = [], f = validateForecast(j.forecast || {}, e2);
      if (e2.length) return sendJson(res, 200, { ok: false, error: e2.join('; ') });
      if (f.lat === null || f.lon === null) return sendJson(res, 200, { ok: false, error: 'Breiten- und Längengrad eintragen.' });
      require('./forecast').test(f).then(function (r) { sendJson(res, 200, r); }, function (e) { sendJson(res, 200, { ok: false, error: e.message }); });
    });
    return true;
  }
  if (what === 'save' && post) {
    readBody(req, 100000, function (j) {
      if (ctx.busy && ctx.busy()) return sendJson(res, 200, { ok: false, errors: ['Während eines Matching-Ablaufs wird nicht gespeichert. Bitte den Ablauf erst beenden oder abbrechen.'] });
      const v = validate(j.config);
      if (v.errors.length) return sendJson(res, 200, { ok: false, errors: v.errors });
      try { save(v.value); } catch (e) { return sendJson(res, 200, { ok: false, errors: ['config.json ließ sich nicht schreiben: ' + e.message] }); }
      console.log(new Date().toLocaleString('de-DE') + ' Seite Anlage: Konfiguration gespeichert, Neustart');
      sendJson(res, 200, { ok: true, port: v.value.httpPort });
      setTimeout(ctx.restart, 400);
    });
    return true;
  }
  sendJson(res, 404, { error: 'unbekannt' });
  return true;
}

return { handle: handle, setPlannerMode: setPlannerMode };
};
