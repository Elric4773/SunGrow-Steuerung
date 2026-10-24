'use strict';
/*
 * Sungrow Steuerung – (C) by Elric M.
 * Nur für die private Nutzung zu Test- und Lernzwecken. Kommerzielle Verwendung jeder Art, die Verwendung im
 * Geschäftsbetrieb und der Weiterverkauf sind untersagt. Benutzung auf eigene Gefahr, ohne Gewährleistung oder Garantie.
 * Einzelheiten: LICENSE und HANDBUCH.md.
 */
/*
 * Prognosen für den Planer: Außentemperatur (Wetter) und PV-Ertrag je Viertelstunde.
 *
 *   Wetter:   Open-Meteo (kostenlos, ohne Schlüssel) – Temperatur und Einstrahlung auf die geneigte Fläche je Dachfläche.
 *   PV:       entweder aus der Einstrahlung von Open-Meteo berechnet (kWp × Einstrahlung × Wirkungsgrad, temperaturkorrigiert)
 *             oder von forecast.solar (kostenlos ohne Schlüssel, höchstens 12 Abrufe je Stunde).
 *   Lernen:   die Prognose wird mit dem tatsächlichen Tagesertrag der Anlage verglichen und über einen Faktor
 *             (0,5 bis 1,6) nachgeführt, damit Verschattung und Ausrichtung mit der Zeit berücksichtigt werden.
 *
 * Gespeichert wird in data/prognose.json.
 */
const fs = require('fs');
const path = require('path');
const web = require('./web');

const SLOT = 15 * 60000;

module.exports = function (ctx) {
  const cfg = ctx.cfg;                     // Abschnitt forecast aus config.json
  const FILE = path.join(ctx.dataDir, 'prognose.json');
  const log = ctx.log || function (t) { console.log(new Date().toLocaleTimeString('de-DE') + ' ' + t); };
  const S = { temp: {}, pv: {}, pvRaw: {}, updatedAt: 0, error: null, fetching: false, cal: {}, factor: 1 };
  let timer = null;

  try { if (!ctx.noStore) { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); Object.assign(S, { temp: j.temp || {}, pv: j.pv || {}, pvRaw: j.pvRaw || {}, updatedAt: j.updatedAt || 0, cal: j.cal || {} }); } } catch (e) { /* noch nichts */ }

  function planes() { return (Array.isArray(cfg.planes) ? cfg.planes : []).filter(function (p) { return Number(p.kwp) > 0; }); }
  function kwpTotal() { return planes().reduce(function (a, p) { return a + Number(p.kwp); }, 0); }
  function ymd(d) { const p = function (n) { return n < 10 ? '0' + n : '' + n; }; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
  function save() { fs.writeFile(FILE, JSON.stringify({ temp: S.temp, pv: S.pv, pvRaw: S.pvRaw, updatedAt: S.updatedAt, cal: S.cal }), function () {}); }
  function prune(o) { const cut = Date.now() - 2 * 86400000; Object.keys(o).forEach(function (k) { if (+k < cut) delete o[k]; }); }
  function ymdLocal(t) { return ymd(new Date(t)); }

  /* Lernfaktor: Summe Ist / Summe Prognose der letzten 14 Tage mit brauchbaren Werten */
  function updateFactor() {
    const days = Object.keys(S.cal).sort().slice(-14);
    let f = 0, a = 0;
    days.forEach(function (d) { const c = S.cal[d]; if (c.forecast > 0.5 && c.actual > 0.2 && c.done) { f += c.forecast; a += c.actual; } });
    S.factor = f > 2 ? Math.max(0.5, Math.min(1.6, a / f)) : 1;
    Object.keys(S.cal).sort().slice(0, -40).forEach(function (d) { delete S.cal[d]; });
  }
  updateFactor();

  /* Stundenwerte von Open-Meteo in Viertelstunden legen. Strahlung gilt für die vorangegangene Stunde. */
  function spread(times, values, into, precedingHour, transform) {
    times.forEach(function (ts, i) {
      const v = values[i]; if (v === null || v === undefined) return;
      const t = new Date(ts).getTime(); if (isNaN(t)) return;
      const base = precedingHour ? t - 3600000 : t;
      for (let q = 0; q < 4; q++) {
        let x = v;
        if (!precedingHour && values[i + 1] !== null && values[i + 1] !== undefined) x = v + (values[i + 1] - v) * q / 4;    // Temperatur linear
        into[base + q * SLOT] = transform ? transform(x) : x;
      }
    });
  }

  function fetchOpenMeteo() {
    const base = cfg.urlWeather || 'https://api.open-meteo.com/v1/forecast';
    const ps = planes();
    const common = '?latitude=' + Number(cfg.lat) + '&longitude=' + Number(cfg.lon) + '&timezone=UTC&forecast_days=7&timeformat=iso8601';
    const temp = {}, pvRaw = {};
    const calls = [web.fetchJson(base + common + '&hourly=temperature_2m', 15000).then(function (j) {
      if (!j.hourly) throw new Error('Open-Meteo: unerwartete Antwort');
      spread(j.hourly.time.map(function (s) { return s + 'Z'; }), j.hourly.temperature_2m, temp, false);
    })];
    if ((cfg.provider || 'openmeteo') === 'openmeteo') {
      ps.forEach(function (p) {
        const url = base + common + '&hourly=global_tilted_irradiance,temperature_2m&tilt=' + Number(p.tilt || 30) + '&azimuth=' + Number(p.azimuth || 0);
        calls.push(web.fetchJson(url, 15000).then(function (j) {
          if (!j.hourly || !j.hourly.global_tilted_irradiance) throw new Error('Open-Meteo: keine Einstrahlung erhalten');
          const kwp = Number(p.kwp), pr = Number(cfg.performanceRatio) || 0.85, tcoef = 0.004;
          const times = j.hourly.time.map(function (s) { return s + 'Z'; });
          const watts = j.hourly.global_tilted_irradiance.map(function (g, i) {
            if (g === null || g === undefined) return null;
            const ta = j.hourly.temperature_2m[i] === null ? 15 : j.hourly.temperature_2m[i];
            const tcell = ta + 25 * g / 1000;
            return Math.max(0, g / 1000 * kwp * 1000 * pr * (1 - tcoef * (tcell - 25)));
          });
          const one = {}; spread(times, watts, one, true);
          Object.keys(one).forEach(function (k) { pvRaw[k] = (pvRaw[k] || 0) + one[k]; });
        }));
      });
    }
    return Promise.all(calls).then(function () { return { temp: temp, pvRaw: pvRaw }; });
  }

  function fetchForecastSolar() {
    const base = cfg.urlSolar || 'https://api.forecast.solar/estimate';
    const pvRaw = {};
    let p = Promise.resolve();
    planes().forEach(function (pl) {
      p = p.then(function () {
        const url = base + '/' + Number(cfg.lat) + '/' + Number(cfg.lon) + '/' + Number(pl.tilt || 30) + '/' + Number(pl.azimuth || 0) + '/' + Number(pl.kwp);
        return web.fetchJson(url, 20000).then(function (j) {
          const w = j && j.result && j.result.watts; if (!w) throw new Error('forecast.solar: unerwartete Antwort');
          const keys = Object.keys(w).sort();
          keys.forEach(function (k, i) {
            const t = new Date(k.replace(' ', 'T')).getTime(); if (isNaN(t)) return;
            const next = keys[i + 1] ? new Date(keys[i + 1].replace(' ', 'T')).getTime() : t + 3600000;
            for (let s = Math.floor(t / SLOT) * SLOT; s < next; s += SLOT) {
              const frac = (Math.min(next, s + SLOT) - Math.max(t, s)) / SLOT;
              pvRaw[s] = (pvRaw[s] || 0) + w[k] * frac;
            }
          });
        });
      });
    });
    return p.then(function () { return pvRaw; });
  }

  function refresh() {
    if (S.fetching) return Promise.resolve(false);
    if (!(Number(cfg.lat) >= -90 && Number(cfg.lat) <= 90 && Number(cfg.lon) >= -180 && Number(cfg.lon) <= 180)) { S.error = 'Standort fehlt (Seite Anlage, Prognose)'; return Promise.resolve(false); }
    S.fetching = true;
    return fetchOpenMeteo().then(function (om) {
      return ((cfg.provider || 'openmeteo') === 'forecastsolar' ? fetchForecastSolar() : Promise.resolve(om.pvRaw)).then(function (pvRaw) {
        S.temp = om.temp; S.pvRaw = pvRaw;
        S.pv = {}; Object.keys(pvRaw).forEach(function (k) { S.pv[k] = Math.round(pvRaw[k] * S.factor); });
        prune(S.temp); prune(S.pv); prune(S.pvRaw);
        S.updatedAt = Date.now(); S.error = null; S.fetching = false;
        // Prognose des heutigen Tages merken, damit abends der Vergleich mit dem Ist möglich ist
        const day = ymd(new Date()), c = S.cal[day] || (S.cal[day] = { forecast: 0, actual: 0, done: false, since: Date.now() });
        if (!c.done) c.forecast = Math.round(dayKwh(S.pvRaw, new Date()) * 100) / 100;
        if (!ctx.noStore) save();
        log('Prognose geladen: PV heute ' + dayKwh(S.pv, new Date()).toFixed(1) + ' kWh, morgen ' + dayKwh(S.pv, new Date(Date.now() + 86400000)).toFixed(1) + ' kWh, Lernfaktor ' + S.factor.toFixed(2));
        if (ctx.onUpdate) ctx.onUpdate();
        return true;
      });
    }).catch(function (e) {
      S.fetching = false;
      if (S.error !== e.message) log('Prognose: ' + e.message);
      S.error = e.message;
      return false;
    });
  }

  function dayKwh(map, d) {
    const a = new Date(d); a.setHours(0, 0, 0, 0); const b = a.getTime() + 86400000;
    let s = 0; for (let t = a.getTime(); t < b; t += SLOT) s += (map[t] || 0) / 4000;
    return s;
  }

  /* Vom Messbetrieb aufgerufen: tatsächlicher Tagesertrag der Anlage in kWh (Zählerstand "heute") */
  function reportActual(kwhToday) {
    if (!(kwhToday >= 0)) return;
    const day = ymd(new Date()), c = S.cal[day] || (S.cal[day] = { forecast: Math.round(dayKwh(S.pvRaw, new Date()) * 100) / 100, actual: 0, done: false, since: Date.now() });
    c.actual = Math.max(c.actual, Math.round(kwhToday * 100) / 100);
    const h = new Date().getHours();
    if (h >= 22 && !c.done && Date.now() - (c.since || 0) > 10 * 3600000) { /* nur werten, wenn die Prognose den Tag über bekannt war */ c.done = true; updateFactor(); save(); log('Prognose gelernt: heute ' + c.forecast + ' kWh erwartet, ' + c.actual + ' kWh gemessen, Lernfaktor jetzt ' + S.factor.toFixed(2)); }
  }

  /* Tagesausblick: je Kalendertag PV-Ertrag, Temperatur min/max/mittel */
  function daily(days) {
    const out = [];
    for (let i = 0; i < days; i++) {
      // Kalendertage über setDate, damit die Zeitumstellung (25-/23-Stunden-Tag) keinen Tag doppelt oder gar nicht zählt
      const da = new Date(); da.setHours(0, 0, 0, 0); da.setDate(da.getDate() + i); const db = new Date(da); db.setDate(db.getDate() + 1);
      const a = da.getTime(), b = db.getTime();
      let pv = 0, tmin = null, tmax = null, tsum = 0, tn = 0, have = false;
      for (let t = a; t < b; t += SLOT) { if (S.pv[t] !== undefined) { pv += S.pv[t] / 4000; have = true; } const x = S.temp[t]; if (x !== undefined) { tmin = tmin === null ? x : Math.min(tmin, x); tmax = tmax === null ? x : Math.max(tmax, x); tsum += x; tn++; } }
      out.push({ day: ymdLocal(a), t: a, pvKwh: have ? Math.round(pv * 10) / 10 : null, tMin: tmin === null ? null : Math.round(tmin * 10) / 10, tMax: tmax === null ? null : Math.round(tmax * 10) / 10, tAvg: tn ? Math.round(tsum / tn * 10) / 10 : null });
    }
    return out;
  }
  function series(from, to) {
    const out = [];
    for (let t = Math.floor(from / SLOT) * SLOT; t < to; t += SLOT) out.push({ t: t, pvW: S.pv[t] === undefined ? null : S.pv[t], tempC: S.temp[t] === undefined ? null : Math.round(S.temp[t] * 10) / 10 });
    return out;
  }

  function schedule() { timer = setTimeout(function () { refresh().then(schedule); }, (cfg.provider === 'forecastsolar' ? 120 : 60) * 60000); }

  return {
    start: function () { refresh().then(schedule); },
    stop: function () { if (timer) clearTimeout(timer); },
    refresh: refresh, series: series, daily: daily, reportActual: reportActual, kwpTotal: kwpTotal,
    state: function () {
      return { provider: cfg.provider || 'openmeteo', updatedAt: S.updatedAt, error: S.error, factor: S.factor, kwp: kwpTotal(), planes: planes().length,
        todayKwh: Math.round(dayKwh(S.pv, new Date()) * 10) / 10, tomorrowKwh: Math.round(dayKwh(S.pv, new Date(Date.now() + 86400000)) * 10) / 10,
        cal: Object.keys(S.cal).sort().slice(-14).map(function (d) { return Object.assign({ day: d }, S.cal[d]); }) };
    }
  };
};

/* Für die Seite Anlage: Abruf mit den eingegebenen Werten, ohne zu speichern */
module.exports.test = function (f) {
  const tmp = module.exports({ cfg: f, dataDir: '.', noStore: true, log: function () {} });
  return tmp.refresh().then(function (ok) {
    const st = tmp.state();
    if (!ok) throw new Error(st.error || 'keine Daten');
    const now = tmp.series(Date.now(), Date.now() + SLOT)[0];
    return { ok: true, todayKwh: st.todayKwh, tomorrowKwh: st.tomorrowKwh, tempNow: now ? now.tempC : null, pvNow: now ? now.pvW : null };
  });
};
module.exports.SLOT = SLOT;
