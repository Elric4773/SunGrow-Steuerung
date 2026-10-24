'use strict';
/*
 * Sungrow Steuerung – (C) by Elric M.
 * Nur für die private Nutzung zu Test- und Lernzwecken. Kommerzielle Verwendung jeder Art, die Verwendung im
 * Geschäftsbetrieb und der Weiterverkauf sind untersagt. Benutzung auf eigene Gefahr, ohne Gewährleistung oder Garantie.
 * Einzelheiten: LICENSE und HANDBUCH.md.
 */
/*
 * Modbus-Client über TCP mit zwei Rahmenformaten:
 *   'tcp'  Modbus TCP (MBAP-Kopf mit Transaktionsnummer), wie beim WiNet-S der Sungrow-Geräte
 *   'rtu'  Modbus RTU über TCP (Geräteadresse, Funktion, Daten, CRC16), wie ihn einfache RS485-Ethernet-Umsetzer
 *          im "transparenten" Betrieb durchreichen. So hängt zum Beispiel der Carel-Regler einer Wärmepumpe am Netz.
 * Anfragen laufen strikt nacheinander über eine Verbindung. Lesen (FC03, FC04) und Schreiben eines Registers (FC06).
 */
const net = require('net');

const MODBUS_EXCEPTIONS = {
  1: 'Funktion nicht unterstützt',
  2: 'Registeradresse unbekannt',
  3: 'ungültiger Wert',
  4: 'Gerätefehler',
  6: 'Gerät beschäftigt',
  10: 'Gateway: Pfad nicht verfügbar',
  11: 'Gateway: Zielgerät antwortet nicht'
};

function crc16(buf, len) {
  let crc = 0xffff;
  for (let i = 0; i < len; i++) {
    crc ^= buf[i];
    for (let b = 0; b < 8; b++) crc = (crc & 1) ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc;
}

function ModbusClient(host, port, timeoutMs, framing) {
  this.host = host;
  this.port = port;
  this.timeoutMs = timeoutMs || 4000;
  this.framing = framing === 'rtu' ? 'rtu' : 'tcp';
  this.sock = null;
  this.buf = Buffer.alloc(0);
  this.tid = 0;
  this.pending = null;
  this.chain = Promise.resolve();
}

ModbusClient.prototype.connect = function () {
  const self = this;
  return new Promise(function (resolve, reject) {
    const s = net.createConnection({ host: self.host, port: self.port });
    let settled = false;
    const timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      s.destroy();
      reject(new Error('keine Antwort beim Verbindungsaufbau'));
    }, self.timeoutMs);
    s.setNoDelay(true);
    s.once('connect', function () {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      self.sock = s;
      self.buf = Buffer.alloc(0);
      resolve();
    });
    s.on('data', function (d) { if (self.sock === s) self._onData(d); });
    s.on('error', function (e) {
      if (!settled) { settled = true; clearTimeout(timer); reject(e); }
      if (self.sock === s) { self.sock = null; self._fail(e); }
    });
    s.on('close', function () {
      if (self.sock === s) { self.sock = null; self._fail(new Error('Verbindung vom Gerät geschlossen')); }
    });
  });
};

ModbusClient.prototype._fail = function (err) {
  const p = this.pending;
  if (!p) return;
  this.pending = null;
  clearTimeout(p.timer);
  p.reject(err);
};

ModbusClient.prototype._onData = function (d) {
  this.buf = Buffer.concat([this.buf, d]);
  if (this.framing === 'tcp') {
    while (this.buf.length >= 7) {
      const len = this.buf.readUInt16BE(4);
      if (this.buf.length < 6 + len) return;
      const frame = this.buf.slice(0, 6 + len);
      this.buf = this.buf.slice(6 + len);
      this._onPdu(frame.readUInt16BE(0), frame[6], frame.slice(7));
    }
    return;
  }
  // RTU: Länge ergibt sich aus der Funktion; Ausnahme-Antworten sind 5 Byte lang
  while (this.buf.length >= 5) {
    const fc = this.buf[1];
    let need;
    if (fc & 0x80) need = 5;
    else if (fc === 3 || fc === 4) need = 5 + this.buf[2];
    else if (fc === 6 || fc === 16) need = 8;
    else { this.buf = Buffer.alloc(0); return; }           // unbekannte Antwort: Puffer verwerfen, Zeitüberschreitung folgt
    if (this.buf.length < need) return;
    const frame = this.buf.slice(0, need);
    this.buf = this.buf.slice(need);
    const want = crc16(frame, need - 2), got = frame.readUInt16LE(need - 2);
    if (want !== got) { this._fail(new Error('CRC-Fehler in der Antwort (RTU)')); this.buf = Buffer.alloc(0); return; }
    this._onPdu(null, frame[0], frame.slice(1, need - 2));
  }
};

/* pdu: Funktionscode plus Daten, ohne Kopf und ohne CRC */
ModbusClient.prototype._onPdu = function (tid, unit, pdu) {
  const p = this.pending;
  if (!p || (tid !== null && tid !== p.tid) || pdu.length < 2) return;
  if (tid === null && unit !== p.unit) return;
  this.pending = null;
  clearTimeout(p.timer);
  const fc = pdu[0];
  if (fc & 0x80) {
    const code = pdu[1];
    const e = new Error('Modbus-Ausnahme ' + code + ' (' + (MODBUS_EXCEPTIONS[code] || 'unbekannt') + ')');
    e.modbus = code;
    p.reject(e);
    return;
  }
  if (fc === 6 || fc === 16) { p.resolve([pdu.length >= 5 ? pdu.readUInt16BE(3) : 0]); return; }
  const n = pdu[1];
  const out = [];
  for (let i = 0; i + 1 < n && 2 + i + 1 < pdu.length; i += 2) out.push(pdu.readUInt16BE(2 + i));
  p.resolve(out);
};

/* Ein einzelnes Holding-Register schreiben (FC06). */
ModbusClient.prototype.write = function (unit, addr, value) {
  const self = this;
  const run = function () { return self._request(unit, 6, addr, value & 0xffff); };
  const r = this.chain.then(run, run);
  this.chain = r.catch(function () {});
  return r;
};

ModbusClient.prototype.read = function (unit, fc, addr, count) {
  const self = this;
  const run = function () { return self._request(unit, fc, addr, count); };
  const r = this.chain.then(run, run);
  this.chain = r.catch(function () {});
  return r;
};

ModbusClient.prototype._request = function (unit, fc, addr, value) {
  const self = this;
  const ready = this.sock ? Promise.resolve() : this.connect();
  return ready.then(function () {
    return new Promise(function (resolve, reject) {
      self.tid = (self.tid + 1) & 0xffff;
      const tid = self.tid;
      let req;
      if (self.framing === 'tcp') {
        req = Buffer.alloc(12);
        req.writeUInt16BE(tid, 0);
        req.writeUInt16BE(0, 2);
        req.writeUInt16BE(6, 4);
        req[6] = unit; req[7] = fc;
        req.writeUInt16BE(addr, 8);
        req.writeUInt16BE(value, 10);
      } else {
        req = Buffer.alloc(8);
        req[0] = unit; req[1] = fc;
        req.writeUInt16BE(addr, 2);
        req.writeUInt16BE(value, 4);
        req.writeUInt16LE(crc16(req, 6), 6);
        self.buf = Buffer.alloc(0);                 // RTU kennt keine Transaktionsnummer: alte Reste wegwerfen
      }
      const timer = setTimeout(function () {
        if (self.pending && self.pending.tid === tid) {
          self.pending = null;
          self.close();
          reject(new Error('Zeitüberschreitung (Unit ' + unit + ', Adresse ' + addr + ')'));
        }
      }, self.timeoutMs);
      self.pending = { tid: tid, unit: unit, resolve: resolve, reject: reject, timer: timer };
      self.sock.write(req);
    });
  });
};

ModbusClient.prototype.close = function () {
  if (this.sock) { const s = this.sock; this.sock = null; s.destroy(); }
  this.buf = Buffer.alloc(0);
};

module.exports = ModbusClient;
module.exports.crc16 = crc16;
module.exports.EXCEPTIONS = MODBUS_EXCEPTIONS;
