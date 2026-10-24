'use strict';
/*
 * Sungrow Steuerung – (C) by Elric M.
 * Nur für die private Nutzung zu Test- und Lernzwecken. Kommerzielle Verwendung jeder Art, die Verwendung im
 * Geschäftsbetrieb und der Weiterverkauf sind untersagt. Benutzung auf eigene Gefahr, ohne Gewährleistung oder Garantie.
 * Einzelheiten: LICENSE und HANDBUCH.md.
 */
/*
 * Steuerteil der Sungrow Steuerung: Einstellungen des Hybridwechselrichters (Sungrow SH-RT) und Matching-Assistent.
 * Läuft im selben Prozess wie der Monitor und benutzt dessen Modbus-Verbindung mit: es gibt genau einen,
 * der mit dem Wechselrichter spricht. Geschrieben wird nur von hier, und nur auf Knopfdruck oder im Ablauf.
 */
const fs = require('fs');
const path = require('path');

const DEFAULTS = { targetModule: 8, fineWatts: 3000, trimWatts: 1500, chargeWatts: 5000, bulkVolt: 3.12, kneeVolt: 3.05, floorVolt: 2.90,
  restMinutes: 10, trimMinutes: 3, trimRestMinutes: 5, toleranceMv: 20, chargeToSoc: 40, maxStepHours: 4, tickSeconds: 5 };

module.exports = function (ctx) {
const cfg = ctx.cfg, state = ctx.state, invClient = ctx.invClient, DATA_DIR = ctx.dataDir;
const P = Object.assign({}, DEFAULTS, cfg.matching || {}, { inverter: cfg.inverter });
const STATE_FILE = path.join(DATA_DIR, 'ablauf.json');
const CHANGE_LOG = path.join(DATA_DIR, 'aenderungen.jsonl');
const RATED = cfg.inverter.ratedPower || 10600;
/* Registeradresse zu einem Schlüssel: aus der Konfiguration (Seite Anlage), sonst Sungrow-Standard */
const STD = { emsMode: 13049, forcedCmd: 13050, forcedPower: 13051, minSoc: 13058, backupReserve: 13099, tcEnable: 33207 };
function A(key) { const a = ctx.reg ? ctx.reg(key) : null; return a === null || a === undefined ? STD[key] : a; }

function r(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }
function median(arr) { const a = arr.slice().sort(function (x, y) { return x - y; }); return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null; }

/* Modbus über die Verbindung des Monitors. ops: [{fc:3|4|6, addr, val}] -> Ergebnisliste. Die Anfragen reihen sich hinter
   die laufenden Messabfragen ein. "Beschäftigt" (Ausnahme 4 oder 6) wird bis zu dreimal wiederholt. */
function modbusOp(o, n) {
  const u = cfg.inverter.unitId;
  const p = o.fc === 6 ? invClient.write(u, o.addr, o.val) : invClient.read(u, o.fc, o.addr, o.val);
  return p.catch(function (e) {
    const m = /Modbus-Ausnahme (\d+)/.exec(e.message); if (m) e.modbus = +m[1];
    if (n >= 3 || (e.modbus && e.modbus !== 4 && e.modbus !== 6)) throw e;
    return new Promise(function (res) { setTimeout(res, 2000); }).then(function () { return modbusOp(o, n + 1); });
  });
}
function modbus(ops) {
  const out = [];
  let p = Promise.resolve();
  ops.forEach(function (o) { p = p.then(function () { return modbusOp(o, 0); }).then(function (w) { out.push(w); return new Promise(function (res) { setTimeout(res, cfg.requestGapMs || 200); }); }); });
  return p.then(function () { return out; });
}
function modbusWriteSequence(pairs) { return modbus(pairs.map(function (x) { return { fc: 6, addr: x[0], val: x[1] }; })); }

function wantText(w) { return w.kind === 'normal' ? 'Eigenverbrauch' : w.kind === 'ruhe' ? 'Batterie ruht' : (w.kind === 'laden' ? 'laden' : 'entladen') + ' mit ' + w.watts + ' W'; }
function emsMatches(st, want) {
  if (!st || !want) return false;
  if (want.kind === 'normal') return st.emsMode === 'Eigenverbrauch';
  if (st.emsMode !== 'Zwangsmodus') return false;
  if (want.kind === 'ruhe') return st.forcedCommand === 'Stopp';
  return st.forcedCommand === (want.kind === 'laden' ? 'Laden' : 'Entladen') && st.forcedPowerW === want.watts;
}
function emsPairs(want) {
  if (want.kind === 'normal') return [[A('forcedCmd'), 0xcc], [A('forcedPower'), 0], [A('emsMode'), 0]];
  const cmd = want.kind === 'laden' ? 0xaa : want.kind === 'entladen' ? 0xbb : 0xcc;
  // erst Leistung und Befehl, dann die Betriebsart: so läuft er nie mit einem alten Leistungswert los
  return [[A('forcedPower'), want.kind === 'ruhe' ? 0 : Math.max(0, Math.min(RATED, want.watts || 0))], [A('forcedCmd'), cmd], [A('emsMode'), 2]];
}
/* Für den Planer: Zwangsmodus setzen, ohne den Matching-Ablauf zu berühren. Während eines Ablaufs abgelehnt. */
function logChange(who, what) {
  const entry = { t: Date.now(), id: 'emsMode', label: 'Betriebsart (' + who + ')', addr: A('emsMode'), from: '', to: what, ok: true };
  fs.appendFile(CHANGE_LOG, JSON.stringify(entry) + '\n', function () {});
}
function applyEmsExternal(want) {
  if (M.active) return Promise.reject(new Error('Matching-Ablauf läuft, der Wechselrichter gehört gerade dem Ablauf'));
  return modbusWriteSequence(emsPairs(want)).then(function () { logChange('Planer', wantText(want)); });
}
function emsApply(want) {
  M.lastWrite = Date.now();
  const pairs = emsPairs(want);
  return modbusWriteSequence(pairs).then(function () { M.writeError = null; mLog('Wechselrichter gesetzt: ' + wantText(want)); },
    function (e) { M.writeError = e.message; mLog('Schreiben fehlgeschlagen (' + e.message + '), neuer Versuch folgt'); });
}

/* ---------------------------------------------------------------- Ablauf */

const STEPS = [
  { id: 'bulk1', title: 'Grobentladung mit allen Modulen', user: false },
  { id: 'fine1', title: 'Feinentladung bis zum Knie des neuen Moduls', user: false },
  { id: 'rest1', title: 'Ruhe und Referenzmessung', user: false },
  { id: 'remove', title: 'Neues Modul entnehmen', user: true },
  { id: 'bulk2', title: 'Grobentladung der Bestandsmodule', user: false },
  { id: 'fine2', title: 'Feinentladung der Bestandsmodule bis zum Knie', user: false },
  { id: 'rest2', title: 'Ruhe und Vergleich mit der Referenz', user: false },
  { id: 'reinstall', title: 'Neues Modul wieder einsetzen', user: true },
  { id: 'charge', title: 'Gemeinsam nachladen', user: false },
  { id: 'done', title: 'Abschluss', user: false }
];
let M = { active: false, state: 'idle', since: 0, idleSince: 0, orig: null, want: null, paused: null, ref: null, result: null, trims: 0, trimDir: null, trimScale: 1, inTrim: false,
  message: '', warn: '', log: [], lastWrite: 0, writeError: null, startedAt: 0, forceNext: false, forceConfirmed: false };
try { const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); if (saved && saved.state) M = Object.assign(M, saved, { lastWrite: 0 }); } catch (e) { /* kein gespeicherter Ablauf */ }

function mSave() { fs.writeFile(STATE_FILE, JSON.stringify(M), function () {}); }
function mLog(text) {
  M.log.push({ t: Date.now(), text: text }); if (M.log.length > 300) M.log.shift();
  console.log(new Date().toLocaleTimeString('de-DE') + ' ' + text);
  mSave();
}
function mGo(id, message) {
  M.state = id; M.since = Date.now(); M.message = message || 'Einen Moment, ich lese die aktuellen Werte.'; M.warn = ''; M.forceNext = false; M.forceConfirmed = false;
  const st = STEPS.filter(function (x) { return x.id === id; })[0];
  mLog('Schritt: ' + (st ? st.title : id));
}
function mWant(kind, watts) { if (!M.want || M.want.kind !== kind || M.want.watts !== watts) { M.want = { kind: kind, watts: watts }; M.lastWrite = 0; } }

function snapshot() {
  const now = Date.now(), d = { live: state.live, error: state.error, lastOk: state.lastOk };
  if (!d.live) return { ok: false, why: state.error ? 'Der Wechselrichter antwortet nicht (' + state.error + ').' : 'Es liegen noch keine Messwerte vor.' };
  if (d.error || (now - d.lastOk) > 60000) return { ok: false, why: 'Der Wechselrichter antwortet gerade nicht' + (d.error ? ' (' + d.error + ')' : '') + '.' };
  const live = d.live, cells = live.cells, t = P.targetModule;
  const mods = cells ? cells.modules.filter(function (m) { return m.min !== null && m.max !== null; }) : [];
  const target = mods.filter(function (m) { return m.index === t; })[0] || null;
  const others = mods.filter(function (m) { return m.index !== t; });
  return {
    ok: true, bat: live.inverter.battery, grid: live.inverter.gridPower, settings: live.settings || {}, cells: cells, fresh: !!cells,
    target: target, others: others, othersMin: others.length ? Math.min.apply(null, others.map(function (m) { return m.min; })) : null,
    allMin: cells ? cells.cellMin : null
  };
}


/* Vor dem Ablauf: alles aus dem Weg räumen, was eine Entladung bis ans Knie verhindert, und die alten Werte merken.
   Nach dem Ablauf (Abschluss oder Abbruch): untere Entladegrenze und Reserve wiederherstellen. Die Zwangsladung
   nach Zeitfenster bleibt aus, sie ist fast immer ein vergessener Rest. */
function mPrepare() {
  return readSettings(true).then(function (c) {
    const v = c.values, ops = [], notes = [];
    M.orig = { minSoc: v.minSoc, backupReserve: v.backupReserve };
    if (v.tcEnable === 0xaa) { ops.push({ fc: 6, addr: A('tcEnable'), val: 0x55 }); notes.push('Zwangsladung nach Zeitfenster ausgeschaltet'); }
    if (v.backupReserve > 0) { ops.push({ fc: 6, addr: A('backupReserve'), val: 0 }); notes.push('Reserve für Notstrom von ' + v.backupReserve + ' % auf 0 % gesetzt'); }
    if (v.minSoc > 0) { ops.push({ fc: 6, addr: A('minSoc'), val: 0 }); notes.push('untere Entladegrenze von ' + v.minSoc + ' % auf 0 % gesetzt'); }
    if (v.maxDischarge !== undefined && v.maxDischarge < P.fineWatts) notes.push('ACHTUNG: größte Entladeleistung steht auf ' + v.maxDischarge + ' W, weniger als die Feinentladung braucht');
    if (!ops.length) { mLog('Vorprüfung: keine hinderlichen Einstellungen gefunden'); return; }
    return modbus(ops).then(function () { notes.forEach(function (n) { mLog('Vorprüfung: ' + n); }); return readSettings(true); });
  }).catch(function (e) { mLog('Vorprüfung nicht möglich (' + e.message + '). Bitte Einstellungen von Hand prüfen.'); });
}
function mRestore() {
  const o = M.orig; if (!o) return Promise.resolve();
  const ops = [];
  if (o.minSoc !== undefined && o.minSoc > 0) ops.push({ fc: 6, addr: A('minSoc'), val: Math.round(o.minSoc * 10) });
  if (o.backupReserve !== undefined && o.backupReserve > 0 && o.backupReserve < 50) ops.push({ fc: 6, addr: A('backupReserve'), val: Math.round(o.backupReserve) });
  M.orig = null;
  if (!ops.length) return Promise.resolve();
  return modbus(ops).then(function () { mLog('Untere Entladegrenze' + (ops.length > 1 ? ' und Reserve' : '') + ' wiederhergestellt (' + o.minSoc + ' %)'); return readSettings(true); },
    function (e) { mLog('ACHTUNG: untere Entladegrenze konnte nicht wiederhergestellt werden (' + e.message + '). Bitte auf der Seite Einstellungen prüfen, Sollwert ' + o.minSoc + ' %.'); });
}

let busy = false;
function tick() {
  if (busy) return;
  busy = true;
  Promise.resolve().then(function () { return step(0); }).catch(function (e) { console.log('Fehler im Ablauf: ' + e.message); }).then(function () { busy = false; });
}

function step(depth) {
  if (!M.active && !M.want) return;
  const stateBefore = M.state;
  const S = snapshot(), now = Date.now();
  if (!S.ok) { M.warn = S.why + ' Solange kann nichts gesteuert werden; das BMS schützt die Zellen weiter.'; return; }
  const bat = S.bat, mins = (now - M.since) / 60000, resting = Math.abs(bat.current) < 1.0, t = P.targetModule;

  if (!M.active) {                                   // Abbruch läuft aus: Eigenverbrauch herstellen, dann Steuerung beenden
    if (emsMatches(S.settings, M.want)) { mLog('Steuerung beendet, Wechselrichter steht auf ' + wantText(M.want)); M.want = null; M.warn = ''; mSave(); return; }
    if (now - M.lastWrite > Math.max(5, P.tickSeconds * 5) * 1000) return emsApply(M.want);
    return;
  }

  /* Schutz in allen Entladeschritten */
  const discharging = M.state === 'fine1' || M.state === 'fine2' || (M.inTrim && M.trimDir === 'down');
  if (!M.paused && discharging) {
    if (!S.fresh) { M.paused = { reason: 'Es kommen keine aktuellen Zellwerte vom WiNet-S. Entladung angehalten, bis sie wieder da sind.', auto: true }; mLog('Angehalten: keine aktuellen Zellwerte'); }
    else if (S.allMin !== null && S.allMin <= P.floorVolt) {
      mLog('Notgrenze erreicht: Zelle bei ' + S.allMin + ' V, Batterie wird sofort stillgelegt');
      if (M.inTrim) { M.inTrim = false; M.since = now; } else mGo(M.state === 'fine1' ? 'rest1' : 'rest2');
    }
    else if (mins > P.maxStepHours * 60) { M.paused = { reason: 'Zeitlimit für diesen Schritt überschritten. Bitte prüfen, dann fortsetzen oder abbrechen.' }; mLog('Angehalten: Zeitlimit'); }
  }
  if (M.paused && M.paused.auto && S.fresh) { M.paused = null; mLog('Zellwerte wieder da, weiter'); }

  /* Entladebefehl steht, aber es fließt seit drei Minuten nichts: BMS oder Wechselrichter haben die Entladung selbst beendet
     (SOC-Anzeige am unteren Ende). Das ist dann das erreichbare Unten, also weiter zur Ruhemessung. */
  const stalled = function () {
    if (!emsMatches(S.settings, M.want) || Math.abs(bat.power) > 150) { M.idleSince = 0; return false; }
    if (!M.idleSince) { M.idleSince = now; return false; }
    return now - M.idleSince > 180000;
  };
  const exportWarn = function () { M.warn = S.grid < -300 ? 'Es werden gerade ' + (-S.grid / 1000).toFixed(1) + ' kW eingespeist. Erhöhe die Last etwas (zum Beispiel den Ladestrom an der Wallbox).' : ''; };

  if (M.paused) mWant('ruhe');
  else switch (M.state) {
    case 'bulk1':
      mWant('normal'); M.warn = '';
      M.message = 'Schalte jetzt eine große Last zu, zum Beispiel ein E-Auto an der Wallbox mit 12 bis 13 A je Phase. Ich warte, bis Modul ' + t + ' unter Last ' + P.bulkVolt.toFixed(2) + ' V erreicht, und übernehme dann mit fester Leistung.';
      if ((S.target && S.target.min <= P.bulkVolt) || M.forceNext) mGo('fine1');
      break;
    case 'fine1':
      mWant('entladen', P.fineWatts); exportWarn();
      M.message = 'Ich entlade fest mit ' + P.fineWatts + ' W. Stelle die Last so ein (Wallbox etwa 5 bis 6 A je Phase), dass mindestens ' + (P.fineWatts / 1000).toFixed(1) + ' kW Last anliegen, sonst geht der Rest ins Netz. Stopp bei ' + P.kneeVolt.toFixed(2) + ' V in Modul ' + t + '.';
      if (stalled()) { mLog('Der Wechselrichter entlädt nicht weiter (Anzeige ' + bat.soc + ' %), niedrigste Zelle in Modul ' + t + ': ' + (S.target ? S.target.min : '?') + ' V. Das ist das erreichbare Unten.'); M.result = { kneeSoc: bat.soc, kneeAt: now }; M.idleSince = 0; mGo('rest1'); break; }
      if (S.target && S.target.min <= P.kneeVolt) { mLog('Knie erreicht: Modul ' + t + ' bei ' + S.target.min + ' V unter Last, Anzeige ' + bat.soc + ' %'); M.result = { kneeSoc: bat.soc, kneeAt: now }; mGo('rest1'); }
      break;
    case 'rest1':
      mWant('ruhe'); M.warn = '';
      M.message = 'Die Batterie ruht. Schalte die große Last jetzt ab. Referenzmessung in ' + Math.max(0, Math.ceil(P.restMinutes - mins)) + ' Minuten.';
      if (mins >= P.restMinutes && resting && S.target) {
        M.ref = { min: S.target.min, max: S.target.max, mid: r((S.target.min + S.target.max) / 2, 4), t: now };
        mLog('Referenz: Modul ' + t + ' ruht bei ' + M.ref.min + ' bis ' + M.ref.max + ' V (Mitte ' + M.ref.mid + ' V)');
        mGo('remove');
      }
      break;
    case 'remove':
      mWant('ruhe');
      M.message = 'DU BIST DRAN: Anlage nach Sungrow-Anleitung freischalten, Modul ' + t + ' entnehmen, Turm mit den übrigen Modulen schließen und wieder hochfahren. Die Batterie bleibt dabei stillgelegt. Wenn der Turm wieder läuft, klicke auf „Weiter“.';
      if (M.forceNext) {
        if (S.target && !M.forceConfirmed) { M.warn = 'Ich sehe Modul ' + t + ' noch in den Zellwerten. Wenn es wirklich entnommen ist, klicke noch einmal auf „Weiter“.'; M.forceConfirmed = true; }
        else mGo('bulk2');
      }
      break;
    case 'bulk2':
      mWant('normal'); M.warn = '';
      M.message = 'Schalte die große Last wieder zu (z. B. eine Wallbox). Ich warte, bis die Bestandsmodule unter Last ' + P.bulkVolt.toFixed(2) + ' V erreichen. Entlädt der Wechselrichter nicht, steht die SOC-Anzeige vermutlich am Minimum: dann auf „Weiter“ klicken, ich entlade mit fester Leistung.';
      if ((S.othersMin !== null && S.othersMin <= P.bulkVolt) || M.forceNext) mGo('fine2');
      break;
    case 'fine2':
      mWant('entladen', P.fineWatts); exportWarn();
      M.message = 'Ich entlade fest mit ' + P.fineWatts + ' W, genau wie beim neuen Modul. Last wieder auf gut ' + (P.fineWatts / 1000).toFixed(1) + ' kW stellen. Stopp bei ' + P.kneeVolt.toFixed(2) + ' V in den Bestandsmodulen.';
      if (stalled()) { mLog('Der Wechselrichter entlädt nicht weiter (Anzeige ' + bat.soc + ' %), niedrigste Zelle im Bestand: ' + S.othersMin + ' V. Das ist das erreichbare Unten.'); M.trims = 0; M.trimDir = null; M.trimScale = 1; M.idleSince = 0; M.since = now - Math.max(0, P.restMinutes - 3) * 60000 - 1; M.state = 'rest2'; M.message = ''; mLog('Schritt: Ruhe und Vergleich mit der Referenz (Ruhezeit seit dem Stillstand angerechnet)'); break; }
      if (S.othersMin !== null && S.othersMin <= P.kneeVolt) { mLog('Knie der Bestandsmodule erreicht: ' + S.othersMin + ' V unter Last'); M.trims = 0; M.trimDir = null; M.trimScale = 1; mGo('rest2'); }
      break;
    case 'rest2': {
      if (M.inTrim) {
        mWant(M.trimDir === 'down' ? 'entladen' : 'laden', P.trimWatts);
        M.message = 'Feinkorrektur ' + M.trims + ': ' + (M.trimDir === 'down' ? 'entlade' : 'lade') + ' kurz mit ' + P.trimWatts + ' W, danach wieder Ruhe und Vergleich.';
        if (M.forceNext) { M.inTrim = false; M.since = now; mLog('Feinkorrektur von Hand beendet'); break; }
        if (M.trimDir === 'down' && stalled()) { M.inTrim = false; M.idleSince = 0; mLog('Korrektur nach unten nicht möglich, der Wechselrichter entlädt nicht mehr. Weiter mit diesem Stand.'); mGo('reinstall'); break; }
        if ((now - M.trimSince) / 60000 >= P.trimMinutes * M.trimScale || (M.trimDir === 'down' && S.othersMin !== null && S.othersMin <= P.floorVolt + 0.05)) { M.inTrim = false; M.since = now; mLog('Feinkorrektur beendet, Ruhe'); }
        break;
      }
      mWant('ruhe'); M.warn = '';
      if (M.forceNext && M.result && M.result.diffMv !== undefined) { mLog('Korrekturen von Hand beendet bei ' + M.result.diffMv + ' mV Abstand'); mGo('reinstall'); break; }
      const need = M.trims ? P.trimRestMinutes : P.restMinutes;
      M.message = 'Die Bestandsmodule ruhen. Große Last abschalten. Vergleich mit der Referenz in ' + Math.max(0, Math.ceil(need - mins)) + ' Minuten.';
      if (mins >= need && resting && S.others.length && M.ref) {
        // Maßgeblich ist die jeweils schwächste Zelle: sie beendet später jede Entladung. Also niedrigste Zelle gegen niedrigste Zelle.
        const mid = r(median(S.others.map(function (m) { return (m.min + m.max) / 2; })), 4);
        const low = S.othersMin, diff = r((low - M.ref.min) * 1000, 1);
        mLog('Vergleich: niedrigste Zelle im Bestand ruht bei ' + low + ' V, im neuen Modul waren es ' + M.ref.min + ' V, Abstand ' + (diff > 0 ? '+' : '') + diff + ' mV (Modul-Mitten: ' + mid + ' gegen ' + M.ref.mid + ' V)');
        M.result = Object.assign(M.result || {}, { restMid: mid, restMin: low, diffMv: diff });
        if (Math.abs(diff) > P.toleranceMv && M.trims < 8) {
          const dir = diff > 0 ? 'down' : 'up';
          if (dir === 'down' && bat.soc <= 1.5) { mLog('Abstand ' + diff + ' mV über der Toleranz, aber die Anzeige steht bei ' + bat.soc + ' %: tiefer entlädt der Wechselrichter nicht. Weiter mit diesem Stand.'); mGo('reinstall'); break; }
          if (M.trimDir && M.trimDir !== dir) M.trimScale = M.trimScale / 2;          // übers Ziel hinaus: halber Schub
          M.trims++; M.inTrim = true; M.trimDir = dir; M.trimSince = now;
          mLog('Feinkorrektur ' + M.trims + ': ' + (dir === 'down' ? 'entlade' : 'lade') + ' ' + r(P.trimMinutes * M.trimScale, 1) + ' Minuten mit ' + P.trimWatts + ' W');
        } else { if (Math.abs(diff) > P.toleranceMv) mLog('Toleranz nach 8 Korrekturen nicht erreicht, weiter mit diesem Stand'); mGo('reinstall'); }
      }
      break;
    }
    case 'reinstall':
      mWant('ruhe');
      M.message = 'DU BIST DRAN: Anlage freischalten, Modul ' + t + ' wieder oben einsetzen, hochfahren. Wenn der Turm mit allen Modulen läuft, klicke auf „Weiter“. Danach lade ich sofort nach.';
      if (M.forceNext) {
        if (!S.target && !M.forceConfirmed) { M.warn = 'Ich sehe Modul ' + t + ' noch nicht in den Zellwerten. Wenn es eingesetzt ist und der Turm läuft, klicke noch einmal auf „Weiter“.'; M.forceConfirmed = true; }
        else {
          if (S.cells) { M.result = Object.assign(M.result || {}, { spreadAfterMv: S.cells.spreadMv }); mLog('Alle Module zusammen: Spreizung in Ruhe ' + S.cells.spreadMv + ' mV'); }
          mGo('charge');
        }
      }
      break;
    case 'charge':
      mWant('laden', P.chargeWatts); M.warn = '';
      M.message = 'Ich lade mit ' + P.chargeWatts + ' W nach, bis die Anzeige ' + P.chargeToSoc + ' % erreicht. Danach geht es zurück auf Eigenverbrauch.';
      if (S.cells && S.cells.cellMin) { if (!M.chargeStartMin) M.chargeStartMin = S.cells.cellMin; }
      if (mins > 5 && Math.abs(bat.power) < 150) M.warn = 'Der Ladebefehl steht, aber es fließt seit ' + Math.floor(mins) + ' Minuten kein Strom. Nach einem Neustart braucht der Wechselrichter einige Minuten; bleibt es dabei, auf der Seite Einstellungen nach Hinweisen sehen.';
      else if (mins > 3 && S.cells && M.chargeStartMin && S.cells.cellMin > M.chargeStartMin + 0.005) M.warn = '';
      if (bat.soc >= P.chargeToSoc || (S.cells && S.cells.cellMax >= 3.45) || mins > P.maxStepHours * 60) { mLog('Nachladen beendet bei ' + bat.soc + ' %'); mGo('done'); }
      break;
    case 'done':
      mWant('normal');
      M.message = 'Fertig. Der Wechselrichter steht wieder auf Eigenverbrauch. Bei der nächsten Vollladung zeigt das Balancing-Protokoll im Monitor, wie klein die Spreizung am Ladeende geworden ist.';
      if (emsMatches(S.settings, M.want)) { M.active = false; M.want = null; mLog('Ablauf abgeschlossen'); mRestore(); }
      break;
  }
  M.forceNext = false;
  if (M.state !== stateBefore && !depth) return step(1);      // neuer Schritt: Meldung und Sollzustand sofort setzen, nicht erst beim nächsten Takt

  /* Sollzustand herstellen; weicht der Wechselrichter später ab (z. B. nach seinem Neustart), erneut setzen */
  if (M.want && !emsMatches(S.settings, M.want) && now - M.lastWrite > Math.max(5, P.tickSeconds * 5) * 1000) return emsApply(M.want);
}

function action(name) {
  if (name === 'start') {
    if (M.active) return 'Es läuft bereits ein Ablauf.';
    if (!state.live) return 'Es liegen noch keine Messwerte vom Wechselrichter vor. Ohne sie starte ich nicht.';
    M = Object.assign(M, { active: true, chargeStartMin: 0, paused: null, ref: null, result: null, trims: 0, trimDir: null, trimScale: 1, inTrim: false, log: [], startedAt: Date.now(), want: null, writeError: null });
    mLog('Ablauf gestartet, neues Modul ist Nr. ' + P.targetModule);
    mGo('bulk1');
    mPrepare();
  } else if (name === 'next') { if (M.active) { M.forceNext = true; mLog('„Weiter“ geklickt'); } }
  else if (name === 'pause') { if (M.active && !M.paused) { M.paused = { reason: 'Von dir angehalten. Die Batterie ruht.' }; mLog('Von Hand angehalten'); } }
  else if (name === 'resume') { if (M.active && M.paused) { M.paused = null; mLog('Fortgesetzt'); } }
  else if (name === 'abort') { mRestore(); M.active = false; M.paused = null; M.inTrim = false; M.state = 'idle'; M.message = ''; mWant('normal'); mLog('Abgebrochen, stelle Eigenverbrauch wieder her'); }
  else return 'Unbekannte Aktion';
  mSave(); tick();
  return null;
}

function view() {
  const S = snapshot();
  return {
    active: M.active, state: M.state, since: M.since, paused: M.paused, message: M.message, warn: M.warn, writeError: M.writeError,
    want: M.want ? wantText(M.want) : null, ref: M.ref, result: M.result, trims: M.trims, steps: STEPS, params: P, log: M.log.slice(-60),
    monitorOk: S.ok, monitorWhy: S.ok ? null : S.why,
    live: S.ok ? { soc: S.bat.soc, power: S.bat.power, current: S.bat.current, voltage: S.bat.voltage, grid: S.grid, ems: S.settings.emsMode ? S.settings.emsMode + (S.settings.emsMode === 'Zwangsmodus' ? ', ' + S.settings.forcedCommand + ' ' + S.settings.forcedPowerW + ' W' : '') : 'wird gelesen',
      modules: S.cells ? S.cells.modules : [], spreadMv: S.cells ? S.cells.spreadMv : null, cells: S.fresh } : null,
    targetMin: S.ok && S.target ? S.target.min : null, othersMin: S.ok ? S.othersMin : null,
    needsUser: M.active && !M.paused && (M.state === 'remove' || M.state === 'reinstall')
  };
}

/* ---------------------------------------------------------------- Einstellungen des Wechselrichters
   Jede Einstellung ist ein Holding-Register (Adresse 0-basiert = Doku-Nummer minus 1, änderbar auf der Seite Anlage).
   "verified" heißt: beim Entwickeln an einem SH-RT-Gerät geschrieben und das Verhalten beobachtet. Alles andere stammt aus der
   Sungrow-Registerliste für die SH-RT-Serie und ist als ungeprüft gekennzeichnet. */
const SETTINGS = [
  { id: 'emsMode',       group: 'mode',   addr: 13049, label: 'Betriebsart', kind: 'enum', options: [[0, 'Eigenverbrauch'], [2, 'Zwangsmodus'], [3, 'Externes EMS']], verified: true, confirm: true },
  { id: 'forcedCmd',     group: 'mode',   addr: 13050, label: 'Befehl im Zwangsmodus', kind: 'enum', options: [[0xaa, 'Laden'], [0xbb, 'Entladen'], [0xcc, 'Stopp']], verified: true },
  { id: 'forcedPower',   group: 'mode',   addr: 13051, label: 'Leistung im Zwangsmodus', kind: 'number', unit: 'W', scale: 1, min: 0, max: RATED, step: 100, verified: true },
  { id: 'maxSoc',        group: 'soc',    addr: 13057, label: 'Obere Ladegrenze', kind: 'number', unit: '%', scale: 0.1, min: 50, max: 100, step: 1, verified: true },
  { id: 'minSoc',        group: 'soc',    addr: 13058, label: 'Untere Entladegrenze', kind: 'number', unit: '%', scale: 0.1, min: 0, max: 50, step: 1, verified: true },
  { id: 'backupReserve', group: 'soc',    addr: 13099, label: 'Reserve für Notstrom', kind: 'number', unit: '%', scale: 1, min: 0, max: 100, step: 1, verified: true },
  { id: 'maxCharge',     group: 'power',  addr: 33046, label: 'Größte Ladeleistung', kind: 'number', unit: 'W', scale: 10, min: 0, max: RATED, step: 100, verified: false },
  { id: 'maxDischarge',  group: 'power',  addr: 33047, label: 'Größte Entladeleistung', kind: 'number', unit: 'W', scale: 10, min: 0, max: RATED, step: 100, verified: false },
  { id: 'tcEnable',      group: 'timed',  addr: 33207, label: 'Zwangsladung nach Zeitfenster', kind: 'enum', options: [[0xaa, 'ein'], [0x55, 'aus']], verified: true },
  { id: 'tc1StartH',     group: 'timed',  addr: 33209, label: 'Fenster 1 Beginn, Stunde', kind: 'number', unit: 'h', scale: 1, min: 0, max: 24, step: 1, verified: false },
  { id: 'tc1StartM',     group: 'timed',  addr: 33210, label: 'Fenster 1 Beginn, Minute', kind: 'number', unit: 'min', scale: 1, min: 0, max: 59, step: 1, verified: false },
  { id: 'tc1EndH',       group: 'timed',  addr: 33211, label: 'Fenster 1 Ende, Stunde', kind: 'number', unit: 'h', scale: 1, min: 0, max: 24, step: 1, verified: false },
  { id: 'tc1EndM',       group: 'timed',  addr: 33212, label: 'Fenster 1 Ende, Minute', kind: 'number', unit: 'min', scale: 1, min: 0, max: 59, step: 1, verified: false },
  { id: 'tc1Target',     group: 'timed',  addr: 33213, label: 'Fenster 1 Ziel-Ladezustand', kind: 'number', unit: '%', scale: 1, min: 0, max: 100, step: 1, verified: true },
  { id: 'tc2StartH',     group: 'timed',  addr: 33214, label: 'Fenster 2 Beginn, Stunde', kind: 'number', unit: 'h', scale: 1, min: 0, max: 24, step: 1, verified: false },
  { id: 'tc2StartM',     group: 'timed',  addr: 33215, label: 'Fenster 2 Beginn, Minute', kind: 'number', unit: 'min', scale: 1, min: 0, max: 59, step: 1, verified: false },
  { id: 'tc2EndH',       group: 'timed',  addr: 33216, label: 'Fenster 2 Ende, Stunde', kind: 'number', unit: 'h', scale: 1, min: 0, max: 24, step: 1, verified: false },
  { id: 'tc2EndM',       group: 'timed',  addr: 33217, label: 'Fenster 2 Ende, Minute', kind: 'number', unit: 'min', scale: 1, min: 0, max: 59, step: 1, verified: false },
  { id: 'tc2Target',     group: 'timed',  addr: 33218, label: 'Fenster 2 Ziel-Ladezustand', kind: 'number', unit: '%', scale: 1, min: 0, max: 100, step: 1, verified: false },
  { id: 'exportEnable',  group: 'export', addr: 13086, label: 'Einspeisebegrenzung', kind: 'enum', options: [[0xaa, 'ein'], [0x55, 'aus']], verified: false, confirm: true },
  { id: 'exportLimit',   group: 'export', addr: 13073, label: 'Größte Einspeiseleistung', kind: 'number', unit: 'W', scale: 1, min: 0, max: 20000, step: 100, verified: false, confirm: true }
];
SETTINGS.forEach(function (st) { const a = ctx.reg ? ctx.reg(st.id) : null; if (a !== null && a !== undefined) st.addr = a; });
/* Leseblöcke aus den aktuellen Adressen: benachbarte Register in einem Rutsch, jeder Block einzeln abgesichert */
const READ_BLOCKS = (function () {
  const a = SETTINGS.map(function (st) { return st.addr; }).sort(function (x, y) { return x - y; }).filter(function (x, i, l) { return i === 0 || x !== l[i - 1]; });
  const out = [];
  a.forEach(function (x) { const last = out[out.length - 1]; if (last && x - (last[0] + last[1]) <= 2 && x - last[0] < 30) last[1] = x - last[0] + 1; else out.push([x, 1]); });
  return out;
})();
let settingsCache = { at: 0, values: {}, raw: {}, errors: [], reading: null };

function readSettings(force) {
  if (!force && Date.now() - settingsCache.at < 20000) return Promise.resolve(settingsCache);
  if (settingsCache.reading) return settingsCache.reading;
  const raw = {}, errors = [];
  // jeder Block einzeln: kennt die Firmware einen Block nicht, bleiben die anderen lesbar
  let p = Promise.resolve();
  READ_BLOCKS.forEach(function (b) {
    p = p.then(function () {
      return modbus([{ fc: 3, addr: b[0], val: b[1] }]).then(function (res) { res[0].forEach(function (v, k) { raw[b[0] + k] = v; }); },
        function (e) { errors.push('Register ' + b[0] + ' bis ' + (b[0] + b[1] - 1) + ': ' + e.message); });
    });
  });
  settingsCache.reading = p.then(function () {
    const values = {};
    SETTINGS.forEach(function (st) { if (raw[st.addr] !== undefined && raw[st.addr] !== null) values[st.id] = st.kind === 'enum' ? raw[st.addr] : r(raw[st.addr] * st.scale, 1); });
    settingsCache = { at: Date.now(), values: values, raw: raw, errors: errors, reading: null };
    return settingsCache;
  });
  return settingsCache.reading;
}

function applySettings(changes) {
  // changes: [{id, value}] -> prüfen, schreiben, zurücklesen, protokollieren
  const results = [];
  const emsIds = ['emsMode', 'forcedCmd', 'forcedPower'];
  let p = readSettings(true);
  changes.forEach(function (ch) {
    p = p.then(function () {
      const st = SETTINGS.filter(function (x) { return x.id === ch.id; })[0];
      if (!st) { results.push({ id: ch.id, ok: false, message: 'unbekannte Einstellung' }); return; }
      if (M.active && (emsIds.indexOf(st.id) >= 0 || st.id === 'minSoc')) { results.push({ id: st.id, label: st.label, ok: false, message: 'gesperrt, solange der Matching-Ablauf läuft' }); return; }
      let rawVal;
      if (st.kind === 'enum') { rawVal = parseInt(ch.value, 10); if (!st.options.some(function (o) { return o[0] === rawVal; })) { results.push({ id: st.id, label: st.label, ok: false, message: 'ungültige Auswahl' }); return; } }
      else {
        const v = Number(ch.value);
        if (!isFinite(v) || v < st.min || v > st.max) { results.push({ id: st.id, label: st.label, ok: false, message: 'Wert außerhalb von ' + st.min + ' bis ' + st.max + ' ' + st.unit }); return; }
        rawVal = Math.round(v / st.scale);
      }
      const before = settingsCache.raw[st.addr];
      /* Schreiben, dann zurücklesen. Der WiNet-S liefert nach einem Schreibvorgang noch einige Sekunden den alten Wert aus
         seinem Zwischenspeicher, deshalb mit Wartezeit und bis zu drei Versuchen (rund 1,5 s, 4,5 s, 9 s nach dem Schreiben). */
      const wait = function (ms) { return new Promise(function (res) { setTimeout(res, ms); }); };
      const readBack = function (n) {
        return wait(n === 0 ? 1500 : n === 1 ? 3000 : 4500).then(function () { return modbus([{ fc: 3, addr: st.addr, val: 1 }]); }).then(function (res) {
          if (res[0][0] === rawVal || n >= 2) return res[0][0];
          return readBack(n + 1);
        });
      };
      return modbus([{ fc: 6, addr: st.addr, val: rawVal }]).then(function () { return readBack(0); }).then(function (after) {
        const ok = after === rawVal;
        const show = function (x) { return x === undefined ? '?' : st.kind === 'enum' ? ((st.options.filter(function (o) { return o[0] === x; })[0] || [0, 'Wert ' + x])[1]) : r(x * st.scale, 1) + ' ' + st.unit; };
        const entry = { t: Date.now(), id: st.id, label: st.label, addr: st.addr, from: show(before), to: show(after), ok: ok };
        fs.appendFile(CHANGE_LOG, JSON.stringify(entry) + '\n', function () {});
        console.log(new Date().toLocaleTimeString('de-DE') + ' Einstellung ' + st.label + ': ' + entry.from + ' -> ' + entry.to + (ok ? '' : ' (NICHT übernommen)'));
        results.push({ id: st.id, label: st.label, ok: ok, message: ok ? 'übernommen: ' + entry.to : 'der Wechselrichter hat den Wert nicht übernommen, er steht auf ' + entry.to });
      }, function (e) {
        results.push({ id: st.id, label: st.label, ok: false, message: e.modbus === 2 ? 'dieses Register kennt deine Firmware nicht' : e.modbus === 3 ? 'der Wechselrichter lehnt diesen Wert ab' : e.message });
      });
    });
  });
  return p.then(function () { return readSettings(true); }).then(function () { return results; });
}

function changeLog(n) {
  try { return fs.readFileSync(CHANGE_LOG, 'utf8').trim().split('\n').slice(-n).map(function (l) { return JSON.parse(l); }).reverse(); } catch (e) { return []; }
}

/* Hinweise auf Einstellungen, die den Alltag oder einen Ablauf behindern */
function settingHints(v) {
  const h = [];
  if (v.tcEnable === 0xaa) h.push({ level: 'alert', text: 'Zwangsladung nach Zeitfenster ist ein: im Fenster lädt der Wechselrichter mit voller Leistung aus dem Netz und gibt die Batterie nicht zur Entladung frei.' });
  if (v.emsMode === 2) h.push({ level: 'alert', text: 'Zwangsmodus ist aktiv (' + ({ 0xaa: 'Laden', 0xbb: 'Entladen', 0xcc: 'Stopp' }[v.forcedCmd] || '?') + (v.forcedCmd !== 0xcc ? ', ' + v.forcedPower + ' W' : '') + '): der Wechselrichter regelt nicht nach Eigenverbrauch.' });
  if (v.backupReserve >= 50) h.push({ level: 'alert', text: 'Reserve für Notstrom steht auf ' + v.backupReserve + ' %: im Netzbetrieb entlädt die Batterie nur bis dorthin.' });
  if (v.minSoc >= 50) h.push({ level: 'alert', text: 'Untere Entladegrenze steht auf ' + v.minSoc + ' %.' });
  if (v.minSoc !== undefined && v.minSoc < 3) h.push({ level: 'note', text: 'Untere Entladegrenze steht auf ' + v.minSoc + ' %: für den Alltag sind 5 bis 10 % üblich.' });
  if (v.maxSoc !== undefined && v.maxSoc < 100) h.push({ level: 'note', text: 'Obere Ladegrenze steht auf ' + v.maxSoc + ' %: die Batterie wird nicht ganz voll, das Balancing am oberen Ende arbeitet dann kaum.' });
  if (v.maxDischarge !== undefined && v.maxDischarge < 1000) h.push({ level: 'alert', text: 'Größte Entladeleistung steht auf nur ' + v.maxDischarge + ' W.' });
  if (v.maxCharge !== undefined && v.maxCharge < 1000) h.push({ level: 'note', text: 'Größte Ladeleistung steht auf nur ' + v.maxCharge + ' W.' });
  return h;
}


function settingsView() {
  const S = snapshot();
  return { at: settingsCache.at, values: settingsCache.values, errors: settingsCache.errors, defs: SETTINGS, hints: settingHints(settingsCache.values),
    log: changeLog(25), matchingActive: M.active, inverter: cfg.inverter.host + ':' + cfg.inverter.port,
    live: S.ok ? { soc: S.bat.soc, power: S.bat.power, voltage: S.bat.voltage } : null };
}
function sendJson(res, obj) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
function readBody(req, limit, cb) { let body = ''; req.on('data', function (c) { body += c; if (body.length > limit) req.destroy(); }); req.on('end', function () { let j = {}; try { j = JSON.parse(body); } catch (e) { /* leer */ } cb(j); }); }

/* liefert true, wenn die Anfrage hier beantwortet wurde */
function handle(req, res, url) {
  if (url.pathname === '/api/state') {
    if (req.method === 'POST') { readBody(req, 2000, function (j) { const err = action(j.action); sendJson(res, { error: err, state: view() }); }); return true; }
    sendJson(res, view()); return true;
  }
  if (url.pathname === '/api/settings') {
    if (req.method === 'POST') {
      readBody(req, 20000, function (j) {
        applySettings(j.changes || []).then(function (results) { sendJson(res, { results: results, settings: settingsView() }); },
          function (e) { sendJson(res, { results: [{ ok: false, message: e.message }], settings: settingsView() }); });
      });
      return true;
    }
    readSettings(url.searchParams.get('force') === '1').then(function () { sendJson(res, settingsView()); }, function (e) { sendJson(res, { error: e.message }); });
    return true;
  }
  return false;
}

if (M.active) console.log('Gespeicherter Matching-Ablauf wird fortgesetzt im Schritt ' + M.state);
setInterval(tick, Math.max(1, P.tickSeconds) * 1000);
process.on('SIGTERM', function () { try { fs.writeFileSync(STATE_FILE, JSON.stringify(M)); } catch (e) { /* egal */ } });
return { tick: tick, handle: handle, isActive: function () { return M.active; }, applyEms: applyEmsExternal };
};
