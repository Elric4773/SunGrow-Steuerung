#!/usr/bin/env node
/*
 * Sungrow Steuerung – Zählertest
 * (C) by Elric M.
 * Nur für die private Nutzung zu Test- und Lernzwecken. Kommerzielle Verwendung jeder Art, die Verwendung im
 * Geschäftsbetrieb und der Weiterverkauf sind untersagt. Benutzung auf eigene Gefahr, ohne Gewährleistung oder Garantie.
 * Einzelheiten: LICENSE und HANDBUCH.md.
 */
/* Liest Messgeräte am Loxone Miniserver und zum Vergleich den Hybridwechselrichter (Hauslast, Netz, PV) im Takt und
   zeigt alles als laufende Tabelle mit der Änderung seit dem Start. Einen bekannten Verbraucher einschalten
   (Wasserkocher ≈ 2 kW) und schauen, welche Spalte springt – so erkennt man vertauschte oder falsch skalierte Zähler.

   node zaehlertest.js --loxone 192.0.2.15:8080 --user NAME --pass GEHEIM --objekt Zaehler_Haus,Zaehler_WP,Zaehler_Wallbox [--steuerung http://localhost:8787] [--wr 192.0.2.10[:502]] [--unit 1] [--takt 2]

   Die Wechselrichterwerte kommen von der laufenden Steuerung (--steuerung, Vorgabe http://localhost:8787), weil der
   WiNet-S nur eine Modbus-Verbindung zulässt. Läuft die Steuerung nicht, geht es mit --wr direkt per Modbus.
   Schreibt nichts, weder in den Miniserver noch in den Wechselrichter. Ausgabe bewusst ohne Umlaute (NAS-Konsole). Beenden mit Strg+C. */
'use strict';
const http = require('http');
const https = require('https');
const net = require('net');

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def; }
const LOX = arg('loxone', ''), USER = arg('user', ''), PASS = arg('pass', ''), OBJ = arg('objekt', '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
const WR = arg('wr', ''), UNIT = +arg('unit', 1), TAKT = Math.max(1, +arg('takt', 2)), ST = arg('steuerung', WR ? '' : 'http://localhost:8787');
if (!LOX || !OBJ.length) {
  console.log('Aufruf: node zaehlertest.js --loxone IP[:PORT] --user NAME --pass GEHEIM --objekt Name1,Name2,... [--steuerung http://localhost:8787] [--wr IP[:PORT]] [--unit 1] [--takt 2]');
  process.exit(1);
}

/* ---------- Loxone: /jdev/sps/io/<Objekt> mit Basic Auth ---------- */
function loxone(obj) {
  return new Promise(function (resolve, reject) {
    const hp = LOX.split(':'), port = +(hp[1] || 80), lib = port === 443 ? https : http;
    const req = lib.get({ host: hp[0], port: port, path: '/jdev/sps/io/' + encodeURIComponent(obj), rejectUnauthorized: false,
      headers: { Authorization: 'Basic ' + Buffer.from(USER + ':' + PASS).toString('base64'), Accept: 'application/json' } }, function (res) {
      let body = ''; res.setEncoding('utf8'); res.on('data', function (c) { body += c; });
      res.on('end', function () {
        if (res.statusCode === 401) return reject(new Error('401 Anmeldung abgelehnt'));
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        let j; try { j = JSON.parse(body); } catch (e) { return reject(new Error('keine JSON-Antwort')); }
        const ll = j && j.LL; if (!ll) return reject(new Error('unerwartete Antwort'));
        if (String(ll.Code) !== '200') return reject(new Error('Code ' + ll.Code + (String(ll.Code) === '404' ? ' (Objekt nicht gefunden)' : '')));
        const m = /-?\d+(?:[.,]\d+)?/.exec(String(ll.value)); if (!m) return reject(new Error('Wert "' + ll.value + '" ist keine Zahl'));
        resolve({ value: parseFloat(m[0].replace(',', '.')), raw: String(ll.value) });
      });
    });
    req.setTimeout(5000, function () { req.destroy(new Error('Zeitueberschreitung')); });
    req.on('error', reject);
  });
}

/* ---------- Wechselrichter: Modbus TCP, Funktion 04, Hauslast 13007, Einspeisung 13009 (0-basiert), PV 5016 ---------- */
function modbusRead(host, port, unit, addr, count) {
  return new Promise(function (resolve, reject) {
    const s = net.createConnection({ host: host, port: port }), tid = Math.floor(Math.random() * 65535);
    const req = Buffer.alloc(12); req.writeUInt16BE(tid, 0); req.writeUInt16BE(0, 2); req.writeUInt16BE(6, 4); req[6] = unit; req[7] = 4; req.writeUInt16BE(addr, 8); req.writeUInt16BE(count, 10);
    let buf = Buffer.alloc(0), done = false;
    const fin = function (err, val) { if (done) return; done = true; s.destroy(); err ? reject(err) : resolve(val); };
    s.setTimeout(5000, function () { fin(new Error('Zeitueberschreitung')); });
    s.on('error', fin);
    s.on('connect', function () { s.write(req); });
    s.on('data', function (d) {
      buf = Buffer.concat([buf, d]); if (buf.length < 9) return;
      if (buf[7] & 0x80) return fin(new Error('Modbus-Fehler ' + buf[8]));
      const n = buf[8]; if (buf.length < 9 + n) return;
      const words = []; for (let i = 0; i < n / 2; i++) words.push(buf.readUInt16BE(9 + i * 2));
      fin(null, words);
    });
  });
}
function s32(w, i) { return ((w[i + 1] << 16) | w[i]) | 0; }          // Sungrow: niedriges Wort zuerst
function u32(w, i) { return ((w[i + 1] << 16) | w[i]) >>> 0; }
/* Wechselrichterwerte aus der laufenden Steuerung (/api/live) */
function fromSteuerung() {
  return new Promise(function (resolve, reject) {
    let u; try { u = new URL('/api/live', ST); } catch (e) { return reject(new Error('Adresse der Steuerung ungueltig')); }
    const req = (u.protocol === 'https:' ? https : http).get(u, { rejectUnauthorized: false }, function (res) {
      let body = ''; res.setEncoding('utf8'); res.on('data', function (c) { body += c; });
      res.on('end', function () {
        if (res.statusCode !== 200) return reject(new Error('Steuerung antwortet HTTP ' + res.statusCode));
        let j; try { j = JSON.parse(body); } catch (e) { return reject(new Error('Steuerung: keine JSON-Antwort')); }
        if (!j.live || !j.live.inverter) return reject(new Error('Steuerung hat noch keine Messwerte' + (j.error ? ' (' + j.error + ')' : '')));
        const i = j.live.inverter, pl = j.live.plant || {};
        resolve({ haus: pl.loadPower !== undefined ? pl.loadPower : i.loadPower, netz: i.gridPower, pv: pl.pvPower !== undefined ? pl.pvPower : i.pvPower });
      });
    });
    req.setTimeout(5000, function () { req.destroy(new Error('Zeitueberschreitung')); });
    req.on('error', function (e) { reject(new Error('Steuerung nicht erreichbar unter ' + ST + ' (' + e.code + ')')); });
  });
}
function inverter() {
  if (ST) return fromSteuerung();
  const hp = WR.split(':'), host = hp[0], port = +(hp[1] || 502);
  return modbusRead(host, port, UNIT, 13007, 4).then(function (w) {
    return modbusRead(host, port, UNIT, 5016, 2).then(function (p) { return { haus: s32(w, 0), netz: -s32(w, 2), pv: u32(p, 0) }; });
  });
}

/* ---------- Anzeige ---------- */
const HASWR = !!(ST || WR);
const cols = OBJ.slice(); if (HASWR) cols.push('WR Haus', 'WR Netz', 'WR PV');
const first = {};
function pad(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }
function fmt(name, v) {
  if (v === null || v === undefined) return pad('-', 17);
  if (first[name] === undefined) first[name] = v;
  const d = v - first[name];
  return pad(Math.round(v) + ' W', 9) + pad((d >= 0 ? '+' : '') + Math.round(d), 8);
}
function hms() { const d = new Date(); return [d.getHours(), d.getMinutes(), d.getSeconds()].map(function (x) { return String(x).padStart(2, '0'); }).join(':');
}
console.log('Zaehlertest - Werte alle ' + TAKT + ' s, rechts daneben die Aenderung seit dem ersten Wert. Beenden mit Strg+C.');
if (HASWR) console.log('Wechselrichterwerte: ' + (ST ? 'von der laufenden Steuerung ' + ST : 'direkt per Modbus von ' + WR));
console.log('Tipp: einen bekannten Verbraucher einschalten (Wasserkocher ca. 2000 W) und schauen, welche Spalte springt.\n');
console.log(pad('Zeit', 8) + cols.map(function (c) { return pad(c, 17); }).join('  '));
let errShown = {};
function tick() {
  const t0 = Date.now();
  Promise.all(OBJ.map(function (o) { return loxone(o).then(function (r) { return r; }, function (e) { if (errShown[o] !== e.message) { errShown[o] = e.message; console.log('  ' + o + ': ' + e.message); } return null; }); }))
    .then(function (lx) {
      const p = HASWR ? inverter().then(function (r) { return r; }, function (e) { if (errShown.wr !== e.message) { errShown.wr = e.message; console.log('  Wechselrichter: ' + e.message); } return null; }) : Promise.resolve(null);
      return p.then(function (wr) {
        const line = [hms()];
        OBJ.forEach(function (o, i) { line.push(fmt(o, lx[i] ? lx[i].value : null)); });
        if (HASWR) { line.push(fmt('WR Haus', wr ? wr.haus : null)); line.push(fmt('WR Netz', wr ? wr.netz : null)); line.push(fmt('WR PV', wr ? wr.pv : null)); }
        const rawHint = lx.filter(Boolean).some(function (r) { return /[a-zA-Z]/.test(r.raw) && !/W$/.test(r.raw.trim()); }) ? '   (Rohwert mit Einheit: ' + lx.filter(Boolean).map(function (r) { return r.raw; }).join(', ') + ')' : '';
        console.log(line.join('  ') + rawHint);
      });
    })
    .then(function () { setTimeout(tick, Math.max(200, TAKT * 1000 - (Date.now() - t0))); });
}
tick();
