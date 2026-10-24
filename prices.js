'use strict';
/*
 * Sungrow Steuerung – (C) by Elric M.
 * Nur für die private Nutzung zu Test- und Lernzwecken. Kommerzielle Verwendung jeder Art, die Verwendung im
 * Geschäftsbetrieb und der Weiterverkauf sind untersagt. Benutzung auf eigene Gefahr, ohne Gewährleistung oder Garantie.
 * Einzelheiten: LICENSE und HANDBUCH.md.
 */
/*
 * Strompreis je Viertelstunde für einen dynamischen Tarif (z. B. Rabot Energy, Tibber, aWATTar).
 *
 * Dynamische Tarife rechnen den Börsenpreis (EPEX Spot Day-Ahead) plus feste Bestandteile ab. Die Börsenpreise sind
 * öffentlich: hier über aWATTar (stündlich) oder Energy-Charts des Fraunhofer ISE (viertelstündlich). Der Endpreis
 * ergibt sich dann aus
 *     Arbeitspreis = (Börsenpreis + feste Bestandteile netto) × (1 + MwSt)
 * Die festen Bestandteile (Netzentgelt, Stromsteuer, Umlagen, Konzessionsabgabe, Aufschlag des Anbieters) stehen auf
 * der Rechnung oder im Tarifblatt des Anbieters und werden auf der Seite Anlage eingetragen.
 *
 * Die Preise für den Folgetag erscheinen täglich gegen 13 Uhr. Gespeichert wird in data/preise.json.
 */
const fs = require('fs');
const path = require('path');
const web = require('./web');

const SLOT = 15 * 60000;

module.exports = function (ctx) {
  const cfg = ctx.cfg;                              // Abschnitt prices aus config.json
  const FILE = path.join(ctx.dataDir, 'preise.json');
  const log = ctx.log || function (t) { console.log(new Date().toLocaleTimeString('de-DE') + ' ' + t); };
  const S = { slots: {}, source: cfg.exchange || 'none', updatedAt: 0, error: null, fetching: false };
  let timer = null;

  try { if (!ctx.noStore) { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (j && j.slots) { S.slots = j.slots; S.updatedAt = j.updatedAt || 0; } } } catch (e) { /* noch nichts gespeichert */ }

  function vat() { return 1 + (Number(cfg.vatPercent) || 0) / 100; }
  function buyPrice(spotCt) { return Math.round(((spotCt + (Number(cfg.fixedCt) || 0)) * vat()) * 1000) / 1000; }
  function feedIn() { return Number(cfg.feedInCt) || 0; }
  function fallback() { return Number(cfg.fallbackCt) || 30; }

  function ymd(d) { const p = function (n) { return n < 10 ? '0' + n : '' + n; }; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
  function dayStart(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); }

  /* Rohwerte in Viertelstunden-Slots legen. items: [{start (ms), end (ms), spotCt}] */
  function ingest(items) {
    let n = 0;
    items.forEach(function (it) {
      for (let t = Math.floor(it.start / SLOT) * SLOT; t < it.end; t += SLOT) { S.slots[t] = Math.round(it.spotCt * 1000) / 1000; n++; }
    });
    const cutoff = Date.now() - 35 * 86400000;          // fünf Wochen behalten: daraus entsteht das Wochentagsmuster für die Schätzung
    Object.keys(S.slots).forEach(function (k) { if (+k < cutoff) delete S.slots[k]; });
    return n;
  }

  function fetchAwattar() {
    const start = dayStart(new Date()) - 86400000, end = dayStart(new Date()) + 3 * 86400000;
    const base = cfg.url || 'https://api.awattar.de/v1/marketdata';
    return web.fetchJson(base + '?start=' + start + '&end=' + end, 15000).then(function (j) {
      if (!j || !Array.isArray(j.data)) throw new Error('aWATTar: unerwartete Antwort');
      return ingest(j.data.map(function (d) { return { start: d.start_timestamp, end: d.end_timestamp, spotCt: d.marketprice / 10 }; }));
    });
  }
  function fetchEnergyCharts() {
    const a = new Date(Date.now() - 86400000), b = new Date(Date.now() + 2 * 86400000);
    const base = cfg.url || 'https://api.energy-charts.info/price';
    return web.fetchJson(base + '?bzn=' + encodeURIComponent(cfg.zone || 'DE-LU') + '&start=' + ymd(a) + '&end=' + ymd(b), 15000).then(function (j) {
      if (!j || !Array.isArray(j.unix_seconds) || !Array.isArray(j.price)) throw new Error('Energy-Charts: unerwartete Antwort');
      const ts = j.unix_seconds, step = ts.length > 1 ? (ts[1] - ts[0]) * 1000 : 3600000;
      return ingest(ts.map(function (t, i) { return { start: t * 1000, end: t * 1000 + step, spotCt: j.price[i] / 10 }; }).filter(function (x) { return typeof x.spotCt === 'number' && !isNaN(x.spotCt); }));
    });
  }

  function refresh() {
    if (S.fetching) return Promise.resolve(false);
    if (S.source === 'none' || !S.source) { S.error = null; return Promise.resolve(false); }
    S.fetching = true;
    const p = S.source === 'energycharts' ? fetchEnergyCharts() : fetchAwattar();
    return p.then(function (n) {
      S.updatedAt = Date.now(); S.error = null; S.fetching = false; Object.keys(estCache).forEach(function (k) { delete estCache[k]; });
      if (!ctx.noStore) fs.writeFile(FILE, JSON.stringify({ slots: S.slots, updatedAt: S.updatedAt }), function () {});
      log('Strompreise geladen (' + (S.source === 'energycharts' ? 'Energy-Charts' : 'aWATTar') + '): ' + n + ' Viertelstunden, bekannt bis ' + new Date(knownUntil()).toLocaleString('de-DE'));
      if (ctx.onUpdate) ctx.onUpdate();
      return true;
    }, function (e) {
      S.fetching = false;
      if (S.error !== e.message) log('Strompreise: ' + e.message);
      S.error = e.message;
      return false;
    });
  }

  function knownUntil() { const ks = Object.keys(S.slots); return ks.length ? Math.max.apply(null, ks.map(Number)) + SLOT : 0; }
  function hasTomorrow() { return knownUntil() >= dayStart(new Date()) + 2 * 86400000 - SLOT; }

  /* Preis für einen Slot: bekannt → Börsenpreis; unbekannt → Schätzung aus derselben Uhrzeit des Vortags, sonst Ersatzpreis */
  /* Schätzung für Viertelstunden, die die Börse noch nicht kennt: Mittel derselben Viertelstunde an denselben Wochentagen
     der letzten vier Wochen; fehlen die, Mittel derselben Viertelstunde der letzten sieben Tage; sonst der Vortag. */
  const estCache = {};
  function estimate(k) {
    if (estCache[k] !== undefined) return estCache[k];
    let vals = [];
    for (let w = 1; w <= 4; w++) { const v = S.slots[k - w * 7 * 86400000]; if (v !== undefined) vals.push(v); }
    if (vals.length < 2) { vals = []; for (let d = 1; d <= 7; d++) { const v = S.slots[k - d * 86400000]; if (v !== undefined) vals.push(v); } }
    const est = vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length : null;
    estCache[k] = est; return est;
  }
  function at(t) {
    const k = Math.floor(t / SLOT) * SLOT;
    if (S.slots[k] !== undefined) return { spot: S.slots[k], buy: buyPrice(S.slots[k]), known: true };
    if (S.source === 'none' || !S.source) return { spot: null, buy: fallback(), known: true };
    const e = estimate(k);
    if (e !== null) return { spot: Math.round(e * 100) / 100, buy: buyPrice(e), known: false };
    return { spot: null, buy: fallback(), known: false };
  }
  function series(from, to) {
    const out = [];
    for (let t = Math.floor(from / SLOT) * SLOT; t < to; t += SLOT) { const p = at(t); out.push({ t: t, spot: p.spot, buy: p.buy, sell: feedIn(), known: p.known }); }
    return out;
  }

  function schedule() {
    // tagsüber ab 13 Uhr alle 10 Minuten, bis der Folgetag da ist; sonst alle 30 Minuten
    const h = new Date().getHours();
    const soon = S.source !== 'none' && h >= 13 && !hasTomorrow();
    timer = setTimeout(function () { refresh().then(schedule); }, (soon ? 10 : 30) * 60000);
  }

  return {
    start: function () { refresh().then(schedule); },
    stop: function () { if (timer) clearTimeout(timer); },
    refresh: refresh, at: at, series: series, feedIn: feedIn, buyPrice: buyPrice, knownUntil: knownUntil, hasTomorrow: hasTomorrow,
    state: function () {
      const now = at(Date.now());
      return { source: S.source, updatedAt: S.updatedAt, error: S.error, knownUntil: knownUntil(), hasTomorrow: hasTomorrow(), now: now, historyDays: Math.round(Object.keys(S.slots).length / 96), fixedCt: Number(cfg.fixedCt) || 0, vatPercent: Number(cfg.vatPercent) || 0, feedInCt: feedIn(), fallbackCt: fallback(), slots: Object.keys(S.slots).length };
    }
  };
};

/* Für die Seite Anlage: Verbindung zur Börse prüfen, ohne etwas zu speichern */
module.exports.test = function (p) {
  const tmp = module.exports({ cfg: p, dataDir: '.', noStore: true, log: function () {} });
  return tmp.refresh().then(function (ok) {
    const st = tmp.state();
    if (!ok) throw new Error(st.error || 'keine Daten');
    return { ok: true, slots: st.slots, knownUntil: st.knownUntil, hasTomorrow: st.hasTomorrow, now: st.now };
  });
};
module.exports.SLOT = SLOT;
