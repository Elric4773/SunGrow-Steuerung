'use strict';
/*
 * Sungrow Steuerung – (C) by Elric M.
 * Nur für die private Nutzung zu Test- und Lernzwecken. Kommerzielle Verwendung jeder Art, die Verwendung im
 * Geschäftsbetrieb und der Weiterverkauf sind untersagt. Benutzung auf eigene Gefahr, ohne Gewährleistung oder Garantie.
 * Einzelheiten: LICENSE und HANDBUCH.md.
 */
/*
 * Modbus TCP von der Konsole (Telnet, SSH, Eingabeaufforderung).
 *
 *   node modbus.js lesen 4 13019 6            Input-Register (FC04) 13019 bis 13024 lesen
 *   node modbus.js lesen 3 33207 12           Holding-Register (FC03) lesen
 *   node modbus.js schreiben 33207 0x55       ein Holding-Register schreiben (FC06), mit Rückfrage
 *   node modbus.js schreiben 13058 50 --ja    ohne Rückfrage
 *
 * Adressen sind 0-basiert: Registernummer aus der Sungrow-Dokumentation minus 1.
 * Zusätze: --host <IP>  --port <Port>  --unit <Geräteadresse>   (sonst der Hybrid aus config.json)
 */
const net = require('net');
const readline = require('readline');

const args = process.argv.slice(2);
function opt(name, def) { const i = args.indexOf('--' + name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; }
const T = require('./registers').cliTarget(__dirname) || {};
const yes = args.indexOf('--ja') >= 0; if (yes) args.splice(args.indexOf('--ja'), 1);
const host = opt('host', T.host), port = parseInt(opt('port', T.port || 502), 10), unit = parseInt(opt('unit', T.unitId === undefined ? 1 : T.unitId), 10);
const cmd = (args[0] || '').toLowerCase();
const num = function (x) { return /^0x/i.test(String(x)) ? parseInt(x, 16) : parseInt(x, 10); };

function usage() {
  console.log('Aufruf:\n  node modbus.js lesen <3|4> <Adresse> [Anzahl]\n  node modbus.js schreiben <Adresse> <Wert> [--ja]\nZusätze: --host <IP> --port <Port> --unit <Geräteadresse>');
  process.exit(1);
}
if (!host) { console.log('Keine Adresse: die Anlage auf der Seite Anlage einrichten oder --host <IP> angeben.'); process.exit(1); }

function request(fc, addr, val, attempt) {
  return new Promise(function (resolve, reject) {
    const s = net.createConnection({ host: host, port: port });
    let buf = Buffer.alloc(0), done = false;
    const finish = function (err, v) { if (done) return; done = true; clearTimeout(t); s.destroy(); err ? reject(err) : resolve(v); };
    const t = setTimeout(function () { finish(new Error('keine Antwort')); }, 5000);
    s.on('connect', function () {
      const q = Buffer.alloc(12); q.writeUInt16BE(1, 0); q.writeUInt16BE(6, 4); q[6] = unit; q[7] = fc; q.writeUInt16BE(addr, 8); q.writeUInt16BE(val, 10); s.write(q);
    });
    s.on('data', function (d) {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 9) return;
      if (buf[7] & 0x80) { const e = new Error('Modbus-Ausnahme ' + buf[8] + ' (' + ({ 1: 'Funktion nicht unterstützt', 2: 'Registeradresse unbekannt', 3: 'Wert nicht erlaubt', 4: 'Gerät beschäftigt oder Fehler', 6: 'Gerät beschäftigt' }[buf[8]] || 'unbekannt') + ')'); e.code = buf[8]; return finish(e); }
      if (fc === 6) { if (buf.length < 12) return; return finish(null, [buf.readUInt16BE(10)]); }
      if (buf.length < 9 + buf[8]) return;
      const w = []; for (let i = 0; i < buf[8]; i += 2) w.push(buf.readUInt16BE(9 + i));
      finish(null, w);
    });
    s.on('error', function (e) { finish(e); });
  }).catch(function (e) {
    if (attempt >= 3 || (typeof e.code === 'number' && e.code !== 4 && e.code !== 6)) throw e;
    return new Promise(function (r) { setTimeout(r, 2000); }).then(function () { return request(fc, addr, val, attempt + 1); });
  });
}

function show(addr, words) {
  console.log('Adresse  Doku-Nr.   dezimal  mit Vorz.   hex     Zeichen');
  words.forEach(function (v, i) {
    const s = v > 32767 ? v - 65536 : v, ch = [v >> 8, v & 255].map(function (c) { return c >= 32 && c < 127 ? String.fromCharCode(c) : '.'; }).join('');
    console.log(String(addr + i).padStart(7) + String(addr + i + 1).padStart(10) + String(v).padStart(10) + String(s).padStart(11) + '   0x' + ('0000' + v.toString(16).toUpperCase()).slice(-4) + '   ' + ch);
  });
  if (words.length >= 2) console.log('\n32 Bit aus den ersten beiden Registern (Sungrow: niederwertiges Wort zuerst): ' + (words[0] + words[1] * 65536));
}

(async function () {
  try {
    if (cmd === 'lesen') {
      const fc = num(args[1]), addr = num(args[2]), count = num(args[3] || '1');
      if ((fc !== 3 && fc !== 4) || isNaN(addr) || !(count >= 1 && count <= 120)) usage();
      console.log((fc === 3 ? 'Holding' : 'Input') + '-Register, Gerät ' + host + ':' + port + ', Geräteadresse ' + unit + '\n');
      show(addr, await request(fc, addr, count, 0));
    } else if (cmd === 'schreiben') {
      const addr = num(args[1]), val = num(args[2]);
      if (isNaN(addr) || isNaN(val) || val < 0 || val > 65535) usage();
      const before = await request(3, addr, 1, 0).catch(function () { return [null]; });
      console.log('Holding-Register ' + addr + ' (Doku-Nr. ' + (addr + 1) + ') an ' + host + ', Geräteadresse ' + unit);
      console.log('  steht auf:   ' + (before[0] === null ? 'nicht lesbar' : before[0] + ' (0x' + before[0].toString(16).toUpperCase() + ')'));
      console.log('  neuer Wert:  ' + val + ' (0x' + val.toString(16).toUpperCase() + ')');
      if (!yes) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const a = await new Promise(function (r) { rl.question('Wirklich schreiben? (j/n) ', r); }); rl.close();
        if (!/^j/i.test(a.trim())) { console.log('Abgebrochen, nichts geschrieben.'); return; }
      }
      await request(6, addr, val, 0);
      await new Promise(function (r) { setTimeout(r, 3000); });        // der WiNet-S zeigt neue Werte erst nach ein paar Sekunden
      const after = await request(3, addr, 1, 0);
      console.log('  zurückgelesen: ' + after[0] + (after[0] === val ? '  -> übernommen' : '  -> NICHT übernommen (oder der WiNet-S liefert noch den alten Wert, in 10 Sekunden erneut lesen)'));
    } else usage();
  } catch (e) { console.log('Fehler: ' + e.message); process.exit(1); }
})();
