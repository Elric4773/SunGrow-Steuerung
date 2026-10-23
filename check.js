'use strict';
/*
 * Sungrow Steuerung – (C) by Elric M.
 * Nur für die private Nutzung zu Test- und Lernzwecken. Kommerzielle Verwendung jeder Art, die Verwendung im
 * Geschäftsbetrieb und der Weiterverkauf sind untersagt. Benutzung auf eigene Gefahr, ohne Gewährleistung oder Garantie.
 * Einzelheiten: LICENSE und HANDBUCH.md.
 */
/* Aufruf:  node check.js [IP]
   Liest am Hybridwechselrichter alles, was eine Entladung der Batterie verhindern kann. Schreibt nichts.
   Adresse, Port, Geräteadresse und Registeradressen kommen aus config.json (Seite Anlage). */
const net = require('net');
const fs = require('fs');
const path = require('path');

const T = require('./registers').cliTarget(__dirname);
const A = T ? T.A : function (k) { return require('./registers').HYBRID.filter(function (e) { return e.key === k; })[0].addr; };
const host = process.argv[2] || (T && T.host), PORT = T ? T.port : 502, UNIT = T ? T.unitId : 1;
if (!host) { console.log('Aufruf: node check.js <IP>   (oder die Anlage zuerst auf der Seite Anlage einrichten)'); process.exit(1); }

/* Eine Verbindung für alles, Pausen zwischen den Abfragen, bei Abbruch neu verbinden und wiederholen:
   der WiNet-S verträgt keine schnellen Verbindungswechsel, schon gar nicht neben dem laufenden Monitor. */
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
      if (buf[7] & 0x80) { const w = waiter; waiter = null; buf = Buffer.alloc(0); return w({ error: 'Modbus-Ausnahme ' + buf[8] }); }
      if (buf.length < 9 + buf[8]) return;
      const out = []; for (let i = 0; i < buf[8]; i += 2) out.push(buf.readUInt16BE(9 + i));
      const w = waiter; waiter = null; buf = Buffer.alloc(0); w({ w: out });
    });
    const gone = function (e) { clearTimeout(t); if (sock === s) sock = null; if (waiter) { const w = waiter; waiter = null; w({ error: (e && e.code) || 'Verbindung getrennt', retry: true }); } };
    s.on('error', function (e) { gone(e); reject(e); });
    s.on('close', function () { gone(); });
  });
}

function once(fc, addr, count) {
  return new Promise(function (resolve) {
    const t = setTimeout(function () { if (waiter) { waiter = null; if (sock) sock.destroy(); sock = null; resolve({ error: 'keine Antwort', retry: true }); } }, 4000);
    waiter = function (v) { clearTimeout(t); resolve(v); };
    const q = Buffer.alloc(12); q.writeUInt16BE(++tid & 0xffff, 0); q.writeUInt16BE(6, 4); q[6] = UNIT; q[7] = fc; q.writeUInt16BE(addr, 8); q.writeUInt16BE(count, 10);
    sock.write(q);
  });
}

async function read(fc, addr, count) {
  let last = { error: 'keine Verbindung' };
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      if (!sock) { await sleep(attempt ? 2500 : 0); await connect(); }
      last = await once(fc, addr, count);
      if (!last.retry) { await sleep(400); return last; }
    } catch (e) { last = { error: e.code || e.message }; }
  }
  return last;
}
const s16 = function (v) { return v > 32767 ? v - 65536 : v; };
const p2 = function (n) { return n < 10 ? '0' + n : '' + n; };
function line(label, r, fn) { console.log((label + ':                                        ').slice(0, 40) + (r.error ? '(' + r.error + ')' : fn(r.w))); }

(async function () {
  console.log((T ? T.name : 'Wechselrichter') + ' unter ' + host + ':' + PORT + ', Geräteadresse ' + UNIT + '\n');
  line('Betriebsart (EMS)', await read(3, A('emsMode'), 3), function (w) {
    return ({ 0: 'Eigenverbrauch', 2: 'Zwangsmodus', 3: 'Externes EMS', 4: 'VPP' }[w[0]] || 'Modus ' + w[0]) +
      (w[0] === 2 ? ', Befehl ' + ({ 0xaa: 'Laden', 0xbb: 'Entladen', 0xcc: 'Stopp' }[w[1]] || w[1]) + ', ' + w[2] + ' W' : '');
  });
  line('Zwangsladung nach Zeitfenster', await read(3, A('tcEnable'), 7), function (w) {
    return (w[0] === 0xaa ? 'EIN' : w[0] === 0x55 ? 'aus' : 'Wert ' + w[0]) + ', Fenster ' + p2(w[2]) + ':' + p2(w[3]) + ' bis ' + p2(w[4]) + ':' + p2(w[5]) + ', Ziel ' + w[6] + ' %';
  });
  line('SOC-Grenzen', await read(3, A('maxSoc'), 2), function (w) { return 'min ' + w[1] / 10 + ' %, max ' + w[0] / 10 + ' %'; });
  line('Reserve-SOC fuer Notstrom', await read(3, A('backupReserve'), 1), function (w) { return w[0] + ' %'; });
  line('Lade-/Entladegrenze Wechselrichter', await read(3, A('maxCharge'), 2), function (w) { return 'laden ' + w[0] * 10 + ' W, entladen ' + w[1] * 10 + ' W'; });
  line('BMS-Grenzen', await read(4, A('bmsMaxCharge'), 2), function (w) { return 'max. Ladestrom ' + w[0] + ' A, max. Entladestrom ' + w[1] + ' A'; });
  line('Batterie jetzt', await read(4, A('battVoltage'), 6), function (w) {
    return w[0] / 10 + ' V, ' + Math.abs(s16(w[1])) / 10 + ' A, ' + Math.abs(s16(w[2])) + ' W, SOC ' + w[3] / 10 + ' %, ' + s16(w[5]) / 10 + ' Grad';
  });
  line('Betriebsbits', await read(4, A('runningBits'), 1), function (w) {
    const b = w[0], o = [];
    if (b & 1) o.push('Solar erzeugt'); if (b & 2) o.push('Batterie laedt'); if (b & 4) o.push('Batterie entlaedt');
    if (b & 16) o.push('speist ein'); if (b & 32) o.push('bezieht aus dem Netz');
    return o.join(', ') || 'keine';
  });
  line('Netz / Haus', await read(4, A('loadPower'), 4), function (w) {
    const s32 = function (i) { const v = w[i] + w[i + 1] * 65536; return v > 0x7fffffff ? v - 0x100000000 : v; };
    return 'Hauslast laut Wechselrichter ' + s32(0) + ' W, Einspeisung ' + s32(2) + ' W (negativ = Bezug)';
  });
  if (sock) sock.destroy();
  console.log('\nfertig');
})();
