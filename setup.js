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

module.exports = function (ctx) {
const ROOT = ctx.root, CONFIG = path.join(ROOT, 'config.json');
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
    modbusBattery: { unitId: c.battery.unitId, cellBlockAddress: c.battery.cellBlockAddress },
    moduleCount: c.moduleCount, topModuleIndex: c.topModuleIndex, moduleNotes: c.moduleNotes || {},
    targetModule: (c.matching && c.matching.targetModule) || c.moduleCount
  };
}
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
  const modbusBattery = { unitId: int(mb.unitId, 0, 247), cellBlockAddress: int(mb.cellBlockAddress, 0, 65535) };
  if (src === 'modbus' && (modbusBattery.unitId === null || modbusBattery.cellBlockAddress === null)) err.push('Batterie über Modbus: Geräteadresse und Zellblock-Adresse prüfen');
  const moduleCount = int(b.moduleCount, 1, MAX_MODULES); if (moduleCount === null) err.push('Anzahl der Module: 1 bis ' + MAX_MODULES);
  const top = int(b.topModuleIndex, 1, MAX_MODULES); if (top === null || (moduleCount && top > moduleCount)) err.push('Oberstes Modul: 1 bis Anzahl der Module');
  const target = int(b.targetModule, 1, MAX_MODULES); if (target === null || (moduleCount && target > moduleCount)) err.push('Nachgerüstetes Modul: 1 bis Anzahl der Module');
  const notes = {};
  Object.keys(b.moduleNotes || {}).forEach(function (k) { const n = int(k, 1, MAX_MODULES), t = String(b.moduleNotes[k] || '').trim().slice(0, 40); if (n && t && (!moduleCount || n <= moduleCount)) notes[n] = t; });
  return { errors: err, value: { plantName: plantName, httpPort: httpPort, pollSeconds: pollSeconds, inverters: invs, cellSource: src, winet: winet, modbusBattery: modbusBattery,
    moduleCount: moduleCount, topModuleIndex: top, targetModule: target, moduleNotes: notes } };
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
  c.battery = Object.assign({}, c.battery, { enabled: v.cellSource === 'modbus', unitId: v.modbusBattery.unitId === null ? 200 : v.modbusBattery.unitId,
    cellBlockAddress: v.modbusBattery.cellBlockAddress === null ? 10756 : v.modbusBattery.cellBlockAddress });
  c.moduleCount = v.moduleCount; c.topModuleIndex = v.topModuleIndex; c.moduleNotes = v.moduleNotes;
  c.matching = Object.assign({}, c.matching, { targetModule: v.targetModule });
  writeFileConfig(c);
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

  if (what === 'config') { sendJson(res, 200, { config: publicConfig(), types: typeInfo(), maxModules: MAX_MODULES }); return true; }

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

return { handle: handle };
};
