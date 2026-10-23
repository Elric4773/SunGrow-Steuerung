'use strict';
/*
 * Sungrow Steuerung – (C) by Elric M.
 * Nur für die private Nutzung zu Test- und Lernzwecken. Kommerzielle Verwendung jeder Art, die Verwendung im
 * Geschäftsbetrieb und der Weiterverkauf sind untersagt. Benutzung auf eigene Gefahr, ohne Gewährleistung oder Garantie.
 * Einzelheiten: LICENSE und HANDBUCH.md.
 */
/* Zwangsmodus des Hybridwechselrichters von Hand setzen. ACHTUNG: dieses Skript SCHREIBT.
 *
 *   node ems.js status             zeigt den aktuellen Stand
 *   node ems.js laden 3000         Zwangsmodus: laden mit 3000 W
 *   node ems.js entladen 3000      Zwangsmodus: entladen mit 3000 W
 *   node ems.js ruhe               Zwangsmodus: Stopp, die Batterie lädt und entlädt nicht
 *   node ems.js normal             zurück auf Eigenverbrauch
 *
 * Register (Holding): 13049 Betriebsart (0 Eigenverbrauch, 2 Zwangsmodus), 13050 Befehl (0xAA laden, 0xBB entladen,
 * 0xCC stopp), 13051 Leistung in Watt. Adresse, Geräteadresse und abweichende Registeradressen kommen aus config.json.
 */
const net = require('net');
const fs = require('fs');
const path = require('path');

const T = require('./registers').cliTarget(__dirname);
const host = T && T.host, webPort = T ? T.webPort : 8787, PORT = T ? T.port : 502, UNIT = T ? T.unitId : 1, RATED = T ? T.ratedPower : 10600;
const A = function (k) { return T.A(k); };
const action = (process.argv[2] || 'status').toLowerCase();
const power = parseInt(process.argv[3] || '0', 10);
if (!host) { console.log('Kein Wechselrichter eingerichtet: bitte zuerst die Seite Anlage ausfüllen.'); process.exit(1); }
if (['status', 'laden', 'entladen', 'ruhe', 'normal'].indexOf(action) < 0) { console.log('Aufruf: node ems.js status | laden <Watt> | entladen <Watt> | ruhe | normal'); process.exit(1); }
if ((action === 'laden' || action === 'entladen') && !(power >= 100 && power <= RATED)) { console.log('Leistung in Watt angeben, 100 bis ' + RATED + '. Beispiel: node ems.js laden 3000'); process.exit(1); }

let sock = null, buf = Buffer.alloc(0), waiter = null, tid = 0;
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

function connect() {
  return new Promise(function (resolve, reject) {
    const s = net.createConnection({ host: host, port: PORT });
    const t = setTimeout(function () { s.destroy(); reject(new Error('keine Verbindung')); }, 4000);
    s.on('connect', function () { clearTimeout(t); sock = s; buf = Buffer.alloc(0); resolve(); });
    s.on('data', function (d) {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 9 || !waiter) return;
      const fc = buf[7];
      if (fc & 0x80) { const w = waiter, code = buf[8]; waiter = null; buf = Buffer.alloc(0); return w({ error: 'Modbus-Ausnahme ' + code }); }
      if (fc === 6) { if (buf.length < 12) return; const w = waiter, v = buf.readUInt16BE(10); waiter = null; buf = Buffer.alloc(0); return w({ w: [v] }); }
      if (buf.length < 9 + buf[8]) return;
      const out = []; for (let i = 0; i < buf[8]; i += 2) out.push(buf.readUInt16BE(9 + i));
      const w = waiter; waiter = null; buf = Buffer.alloc(0); w({ w: out });
    });
    const gone = function (e) { clearTimeout(t); if (sock === s) sock = null; if (waiter) { const w = waiter; waiter = null; w({ error: (e && e.code) || 'Verbindung getrennt', retry: true }); } };
    s.on('error', function (e) { gone(e); reject(e); });
    s.on('close', function () { gone(); });
  });
}

function once(fc, addr, value) {
  return new Promise(function (resolve) {
    const t = setTimeout(function () { if (waiter) { waiter = null; if (sock) sock.destroy(); sock = null; resolve({ error: 'keine Antwort', retry: true }); } }, 4000);
    waiter = function (v) { clearTimeout(t); resolve(v); };
    const q = Buffer.alloc(12); q.writeUInt16BE(++tid & 0xffff, 0); q.writeUInt16BE(6, 4); q[6] = UNIT; q[7] = fc; q.writeUInt16BE(addr, 8); q.writeUInt16BE(value, 10);
    sock.write(q);
  });
}

async function request(fc, addr, value) {
  let last = { error: 'keine Verbindung' };
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      if (!sock) { await sleep(attempt ? 2500 : 0); await connect(); }
      last = await once(fc, addr, value);
      if (!last.retry) { await sleep(500); return last; }
    } catch (e) { last = { error: e.code || e.message }; }
  }
  return last;
}

async function write(addr, value, label) {
  const r = await request(6, addr, value);
  if (r.error) { console.log('  ' + label + ': FEHLGESCHLAGEN (' + r.error + ')'); return false; }
  console.log('  ' + label + ': gesetzt');
  return true;
}

async function status() {
  const r = await request(3, A('emsMode'), 3);
  if (r.error) { console.log('Stand nicht lesbar (' + r.error + ')'); return; }
  const mode = { 0: 'Eigenverbrauch', 2: 'Zwangsmodus', 3: 'Externes EMS', 4: 'VPP' }[r.w[0]] || ('Modus ' + r.w[0]);
  const cmd = { 0xaa: 'laden', 0xbb: 'entladen', 0xcc: 'stopp' }[r.w[1]] || ('0x' + r.w[1].toString(16));
  console.log('Betriebsart: ' + mode + (r.w[0] === 2 ? ', Befehl ' + cmd + ', Leistung ' + r.w[2] + ' W' : ''));
  const b = await request(4, A('battVoltage'), 4);
  if (!b.error) { const p = b.w[2] > 32767 ? 65536 - b.w[2] : b.w[2]; console.log('Batterie:    ' + b.w[0] / 10 + ' V, ' + p + ' W, SOC ' + b.w[3] / 10 + ' %'); }
}

function ablaufAktiv() {
  return new Promise(function (resolve) {
    const req = require('http').get('http://127.0.0.1:' + webPort + '/api/state', function (res) {
      let b = ''; res.on('data', function (c) { b += c; }); res.on('end', function () { try { resolve(!!JSON.parse(b).active); } catch (e) { resolve(false); } });
    });
    req.setTimeout(1500, function () { req.destroy(); });
    req.on('error', function () { resolve(false); });
  });
}

(async function () {
  console.log(T.name + ' unter ' + host + ':' + PORT);
  if (action !== 'status' && process.argv.indexOf('--trotzdem') < 0 && await ablaufAktiv()) {
    console.log('In der Steuerung läuft gerade ein Matching-Ablauf. Der würde diesen Befehl nach wenigen Sekunden überschreiben,');
    console.log('und zwei Schreiber gleichzeitig führen zu Modbus-Ausnahme 4. Bitte den Ablauf dort anhalten oder abbrechen.');
    console.log('Wenn du es trotzdem willst: denselben Befehl mit --trotzdem am Ende.');
    process.exit(1);
  }
  if (action === 'status') { await status(); }
  else if (action === 'ruhe') {
    console.log('Setze Zwangsmodus Stopp (Batterie ruht, laedt und entlaedt nicht):');
    const ok = await write(A('forcedPower'), 0, 'Leistung 0 W') && await write(A('forcedCmd'), 0xcc, 'Befehl stopp') && await write(A('emsMode'), 2, 'Betriebsart Zwangsmodus');
    if (!ok) console.log('Nicht alles wurde uebernommen. Bitte mit "node ems.js status" pruefen.');
    await sleep(3000); await status();
    console.log('\nDas Haus laeuft jetzt aus Solar und Netz. Danach mit "node ems.js normal" zurueck auf Eigenverbrauch.');
  }
  else if (action === 'normal') {
    console.log('Setze zurueck auf Eigenverbrauch:');
    await write(A('forcedCmd'), 0xcc, 'Befehl stopp');
    await write(A('forcedPower'), 0, 'Leistung 0 W');
    await write(A('emsMode'), 0, 'Betriebsart Eigenverbrauch');
    await sleep(1500); await status();
  } else {
    console.log('Setze Zwangsmodus ' + action + ' mit ' + power + ' W:');
    // Reihenfolge: erst Leistung und Befehl, dann die Betriebsart, damit er nie mit einer alten Leistung losläuft
    const ok = await write(A('forcedPower'), power, 'Leistung ' + power + ' W') && await write(A('forcedCmd'), action === 'laden' ? 0xaa : 0xbb, 'Befehl ' + action) && await write(A('emsMode'), 2, 'Betriebsart Zwangsmodus');
    if (!ok) console.log('Nicht alles wurde uebernommen. Bitte mit "node ems.js status" pruefen.');
    await sleep(1500); await status();
    console.log('\nNicht vergessen: danach mit "node ems.js normal" zurueck auf Eigenverbrauch.');
  }
  if (sock) sock.destroy();
})();
