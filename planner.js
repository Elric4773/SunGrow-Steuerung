'use strict';
/*
 * Sungrow Steuerung – (C) by Elric M.
 * Nur für die private Nutzung zu Test- und Lernzwecken. Kommerzielle Verwendung jeder Art, die Verwendung im
 * Geschäftsbetrieb und der Weiterverkauf sind untersagt. Benutzung auf eigene Gefahr, ohne Gewährleistung oder Garantie.
 * Einzelheiten: LICENSE und HANDBUCH.md.
 */
/*
 * Planer: Fahrplan für Batterie und Wärmepumpe aus Strompreis, PV-Prognose, Lastprofil und Heizlast.
 *
 * Alle Viertelstunde (und sobald neue Preise oder Prognosen da sind) rechnet der Planer die nächsten 36 Stunden durch:
 *   1. Grundlast des Hauses je Viertelstunde aus dem eigenen Verlauf der letzten Tage (gleiche Uhrzeit).
 *   2. Stromverbrauch der Wärmepumpe aus der Außentemperatur-Vorhersage, gelernt aus dem eigenen Verlauf, sofern ihre
 *      Leistung gemessen wird; sonst steckt sie in der Grundlast.
 *   3. Ausgangslage "Eigenverbrauch": Batterie lädt aus PV-Überschuss, entlädt bei Bedarf. Das ergibt die Kosten ohne Planer.
 *   4. Verbesserungen, jede nur, wenn sie die Gesamtkosten im Zeitraum tatsächlich senkt:
 *        - aus dem Netz laden in einer billigen Viertelstunde, um Bezug in einer teuren zu vermeiden,
 *        - die Batterie in einer billigen Viertelstunde schonen (nicht entladen), damit sie in einer teuren reicht.
 *   5. Wärmepumpe: Sollwert-Verschiebung nach oben bei PV-Überschuss oder in den billigsten Stunden (Wärme einlagern),
 *      nach unten in den teuersten Stunden, wenn vorher eingelagert wurde.
 *
 * Betriebsarten: aus / Simulation (rechnet und protokolliert, schreibt nichts) / aktiv (schreibt Zwangsmodus des
 * Wechselrichters und die Verschiebung der Wärmepumpe). Während eines Matching-Ablaufs pausiert der Planer.
 */
const fs = require('fs');
const path = require('path');

const SLOT = 15 * 60000;
const DEFAULTS = { mode: 'off', horizonHours: 36, capacityKwh: 0, minSoc: 10, maxSoc: 100, chargeW: 5000, dischargeW: 5000, pvChargeW: 10000, efficiency: 0.88, marginCt: 2,
  baseLoadW: 400, tickSeconds: 60,
  heat: { enabled: false, limitTemp: 15, wattsPerKelvin: 100, kwPerShiftK: 0.15, storeHours: 4, shiftUp: 3, shiftDown: -2, surplusW: 1500, cheapPct: 25, expensivePct: 25 } };

/* ---------------------------------------------------------------- Simulation */


/* slots: [{buy, sell, pvKwh, loadKwh}] ; actions: {charge: [kWh je Slot aus dem Netz], hold: [bool]} */
function simulate(P, slots, actions, soc0, cap) {
  const eff = Math.sqrt(Math.max(0.5, Math.min(1, P.efficiency)));   // je Richtung
  const minE = cap * P.minSoc / 100, maxE = cap * P.maxSoc / 100;
  const chargeMax = P.chargeW / 4000, pvChargeMax = P.pvChargeW / 4000, dischargeMax = P.dischargeW / 4000;
  let e = Math.max(minE, Math.min(maxE, cap * soc0 / 100)), cost = 0;
  const out = new Array(slots.length);
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i]; let imp = 0, exp = 0, bat = 0;     // bat: + laden, - entladen (kWh am Batterieanschluss)
    let net = s.loadKwh - s.pvKwh;                          // + Bedarf, - Überschuss
    if (actions.charge[i] > 0) {
      const want = Math.min(actions.charge[i], chargeMax, (maxE - e) / eff);
      bat += want; e += want * eff; imp += want;            // Netzladung zusätzlich zum Hausbedarf
      if (net > 0) imp += net; else { const c2 = Math.min(-net, Math.max(0, pvChargeMax - want), (maxE - e) / eff); bat += c2; e += c2 * eff; exp += -net - c2; }
    } else if (actions.hold[i]) {
      if (net > 0) imp += net; else { const c2 = Math.min(-net, pvChargeMax, (maxE - e) / eff); bat += c2; e += c2 * eff; exp += -net - c2; }
    } else if (net > 0) {
      const d = Math.min(net, dischargeMax, (e - minE) * eff); e -= d / eff; bat -= d; imp += net - d;
    } else {
      const c2 = Math.min(-net, pvChargeMax, (maxE - e) / eff); bat += c2; e += c2 * eff; exp += -net - c2;
    }
    cost += imp * s.buy - exp * s.sell;
    out[i] = { imp: imp, exp: exp, bat: bat, soc: e / cap * 100 };
  }
  return { cost: cost, slots: out };
}

/* Optimaler Fahrplan durch dynamische Programmierung über den Ladezustand.
   Zustand: Energie in der Batterie (in Stufen), Schritt: Energieänderung je Viertelstunde. Kosten je Schritt wie in der
   Simulation; Netzladung bekommt den Mindestvorteil (marginCt) als Abschlag je kWh, damit sich kein Hin und Her lohnt.
   Energie, die am Ende übrig bleibt, wird mit dem mittleren Preis des Zeitraums gutgeschrieben. */
function optimize(P, slots, soc0, cap) {
  const n = slots.length;
  const none = { charge: new Array(n).fill(0), hold: new Array(n).fill(false) };
  const base = simulate(P, slots, none, soc0, cap);
  const eff = Math.sqrt(Math.max(0.5, Math.min(1, P.efficiency)));
  const minE = cap * P.minSoc / 100, maxE = cap * P.maxSoc / 100;
  const step = Math.min(0.25, Math.max(0.05, (maxE - minE) / 96));
  const L = Math.floor((maxE - minE) / step) + 1;
  const cMaxS = Math.max(1, Math.round(P.chargeW / 4000 * eff / step)), pvMaxS = Math.max(1, Math.round(P.pvChargeW / 4000 * eff / step)), dMaxS = Math.max(1, Math.round(P.dischargeW / 4000 / eff / step));
  // Restenergie am Ende wird vorsichtig bewertet: mit dem billigsten Preis des Zeitraums. So lohnt es sich nicht,
  // die Batterie nur wegen des Horizontendes vollzuladen, und sie wird auch nicht sinnlos leergefahren.
  const credit = Math.min.apply(null, slots.map(function (x) { return x.buy; })) * eff;
  const INF = 1e18;
  let cost = new Float64Array(L).fill(INF), from = [];
  const l0 = Math.max(0, Math.min(L - 1, Math.round((Math.max(minE, Math.min(maxE, cap * soc0 / 100)) - minE) / step)));
  cost[l0] = 0;
  for (let i = 0; i < n; i++) {
    const s = slots[i], net = s.loadKwh - s.pvKwh, pvAvail = Math.max(0, -net), need = Math.max(0, net);
    const next = new Float64Array(L).fill(INF), back = new Int16Array(L).fill(-1), choice = new Int16Array(L);
    for (let l = 0; l < L; l++) {
      if (cost[l] >= INF) continue;
      for (let d = -Math.min(dMaxS, l); d <= Math.min(Math.max(cMaxS, pvMaxS), L - 1 - l); d++) {
        let imp, exp, pen = 0;
        if (d > 0) {
          const gridSide = d * step / eff;                      // was am Netzanschluss ankommen muss
          const usedPv = Math.min(gridSide, pvAvail, pvMaxS * step / eff);
          const gridPart = gridSide - usedPv;
          if (gridPart > cMaxS * step / eff + 1e-9) continue;
          imp = need + gridPart; exp = pvAvail - usedPv; pen = gridPart * P.marginCt;
        } else if (d < 0) {
          const delivered = -d * step * eff;
          if (delivered > need + 1e-9) continue;               // nicht ins Netz entladen
          imp = need - delivered; exp = pvAvail;
        } else { imp = need; exp = pvAvail; }
        const c = cost[l] + imp * s.buy - exp * s.sell + pen;
        if (c < next[l + d]) { next[l + d] = c; back[l + d] = l; choice[l + d] = d; }
      }
    }
    from.push({ back: back, choice: choice }); cost = next;
  }
  // Endzustand: Restenergie zum mittleren Preis gutschreiben
  let bestL = -1, bestC = INF;
  for (let l = 0; l < L; l++) { if (cost[l] >= INF) continue; const c = cost[l] - l * step * credit; if (c < bestC) { bestC = c; bestL = l; } }
  const act = { charge: new Array(n).fill(0), hold: new Array(n).fill(false) };
  let l = bestL, moves = 0;
  for (let i = n - 1; i >= 0; i--) {
    const d = from[i].choice[l], prev = from[i].back[l];
    const s = slots[i], net = s.loadKwh - s.pvKwh, pvAvail = Math.max(0, -net);
    if (d > 0) { const gridSide = d * step / eff, usedPv = Math.min(gridSide, pvAvail); const gridPart = gridSide - usedPv; if (gridPart > 0.01) { act.charge[i] = gridPart; moves++; } }
    else if (d === 0 && net > 0 && prev > 0) { act.hold[i] = true; moves++; }
    l = prev;
  }
  const best = simulate(P, slots, act, soc0, cap);
  const endValue = function (sim) { const last = sim.slots[n - 1]; return last ? last.soc / 100 * cap * credit : 0; };
  const gain = (base.cost - endValue(base)) - (best.cost - endValue(best));
  if (process.env.PLANER_DEBUG) console.log("DP", bestC.toFixed(1), "sim", best.cost.toFixed(1), "base", base.cost.toFixed(1), "gain", gain.toFixed(1), "L", L, "step", step.toFixed(3));
  if (gain < 1) return { base: base, best: base, actions: none, moves: 0, gain: 0 };   // kein lohnender Eingriff
  return { base: base, best: best, actions: act, moves: moves, gain: gain };
}

module.exports = function (ctx) {
  const P = Object.assign({}, DEFAULTS, ctx.cfg || {});
  P.heat = Object.assign({}, DEFAULTS.heat, (ctx.cfg && ctx.cfg.heat) || {});
  const FILE = path.join(ctx.dataDir, 'planer.json');
  const prices = ctx.prices, forecast = ctx.forecast, hp = ctx.heatpump;
  const S = { mode: P.mode, plan: null, plannedAt: 0, totals: null, log: [], want: null, wantSince: 0, applied: null, shift: 0, lastTick: 0, pausedWhy: null, savings: {} };
  let timer = null, replanDue = true;

  try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (j) { S.savings = j.savings || {}; S.log = (j.log || []).slice(-200); } } catch (e) { /* noch nichts */ }
  function save() { fs.writeFile(FILE, JSON.stringify({ savings: S.savings, log: S.log.slice(-200) }), function () {}); }
  function log(text) { S.log.push({ t: Date.now(), text: text }); if (S.log.length > 300) S.log.shift(); console.log(new Date().toLocaleTimeString('de-DE') + ' Planer: ' + text); save(); }
  function r(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }
  function slotOfDay(t) { const d = new Date(t); return d.getHours() * 4 + Math.floor(d.getMinutes() / 15); }

  /* ---------------------------------------------------------------- Lastprofil und Heizlast aus dem Verlauf */

  function loadProfile() {
    const hist = ctx.history() || [];
    const sum = new Array(96).fill(0), cnt = new Array(96).fill(0);
    hist.forEach(function (s) {
      // gemessener Hausverbrauch hat Vorrang; Wärmepumpe und E-Auto werden herausgerechnet, sie plant der Planer getrennt
      const house = (s.mhouse !== undefined ? s.mhouse : (s.load || 0) + (s.pv2h || 0)) - (s.hpw || 0) - (s.carw || 0);
      if (!(house >= 0 && house < 50000)) return;
      const i = slotOfDay(s.t); sum[i] += house; cnt[i]++;
    });
    const out = new Array(96);
    for (let i = 0; i < 96; i++) out[i] = cnt[i] >= 3 ? sum[i] / cnt[i] : null;
    // Lücken mit dem Nachbarn oder dem Tagesmittel füllen
    const known = out.filter(function (x) { return x !== null; });
    const mean = known.length ? known.reduce(function (a, b) { return a + b; }, 0) / known.length : P.baseLoadW;
    for (let i = 0; i < 96; i++) if (out[i] === null) out[i] = out[(i + 95) % 96] !== null ? out[(i + 95) % 96] : mean;
    return { profile: out, days: Math.min(14, Math.round(hist.length / 2880)), learned: known.length > 48 };
  }

  /* Wärmepumpe: Leistung über der Außentemperatur, lineare Regression auf Stundenmitteln aus dem Verlauf (hpw, hpt) */
  function heatModel() {
    const hist = ctx.history() || [];
    const hours = {};
    hist.forEach(function (s) { if (s.hpw === undefined || s.hpt === undefined) return; const h = Math.floor(s.t / 3600000); const o = hours[h] || (hours[h] = { w: 0, t: 0, n: 0 }); o.w += s.hpw; o.t += s.hpt; o.n++; });
    const pts = Object.keys(hours).map(function (k) { return { w: hours[k].w / hours[k].n, t: hours[k].t / hours[k].n }; }).filter(function (p) { return p.t < P.heat.limitTemp; });
    if (pts.length < 24) return { measured: pts.length > 0, learned: false, wattsPerKelvin: P.heat.wattsPerKelvin, limitTemp: P.heat.limitTemp };
    let sx = 0, sy = 0, sxx = 0, sxy = 0; const n = pts.length;
    pts.forEach(function (p) { const x = P.heat.limitTemp - p.t; sx += x; sy += p.w; sxx += x * x; sxy += x * p.w; });
    const slope = (n * sxy - sx * sy) / Math.max(1e-9, n * sxx - sx * sx);
    return { measured: true, learned: true, wattsPerKelvin: Math.max(20, Math.min(600, slope)), limitTemp: P.heat.limitTemp, points: n };
  }

  function capacity(live) {
    const c = Number(P.capacityKwh) > 0 ? Number(P.capacityKwh) : (live && live.inverter.battery.capacityKwh) || 0;
    return c > 0 ? c : 10;
  }

  /* Wärmepumpe: Verschiebung je Viertelstunde.
     Anheben (Wärme einlagern) bei PV-Überschuss mit voller Batterie oder in den billigsten Viertelstunden, solange der
     Speicher (Estrich, Puffer) noch aufnimmt; absenken in den teuersten, solange eingelagerte Wärme da ist. Die Ersparnis
     wird je eingelagerter Portion geschätzt: Preis beim Absenken (oder der mittlere Preis der folgenden vier Stunden)
     minus Preis beim Einlagern, mal der elektrischen Mehrarbeit je Kelvin. */
  function heatPlan(slots, sim, hm) {
    const n = slots.length, shift = new Array(n).fill(0), H = P.heat;
    if (!H.enabled || !hp) return { shift: shift, moved: 0, saving: 0 };
    const buys = slots.map(function (s) { return s.buy; }).slice().sort(function (a, b) { return a - b; });
    const cheap = buys[Math.floor((n - 1) * H.cheapPct / 100)], expensive = buys[Math.floor((n - 1) * (1 - H.expensivePct / 100))];
    const extraKwh = H.kwPerShiftK * H.shiftUp / 4, maxStore = H.storeHours * 4;
    const queue = [];                                   // eingelagerte Portionen: [Preis, Slot]
    let moved = 0, saving = 0;
    const laterAvg = function (i) { let a = 0, c = 0; for (let k = i + 1; k < Math.min(n, i + 17); k++) { a += slots[k].buy; c++; } return c ? a / c : slots[i].buy; };
    for (let i = 0; i < n; i++) {
      const s = slots[i], heating = s.tempC !== null && s.tempC < hm.limitTemp;
      if (!heating) { shift[i] = 0; continue; }
      const surplusW = (s.pvKwh - s.loadKwh) * 4000, full = sim.slots[i].soc >= P.maxSoc - 3;
      const bySun = surplusW > H.surplusW && full;
      if ((bySun || s.buy <= cheap) && queue.length < maxStore) {
        shift[i] = H.shiftUp; moved += extraKwh; queue.push([bySun ? s.sell : s.buy, i]);
      } else if (s.buy >= expensive && queue.length) {
        shift[i] = H.shiftDown; const q = queue.shift(); saving += extraKwh * (s.buy - q[0]);
      } else {
        shift[i] = 0;
        if (queue.length && i - queue[0][1] > maxStore * 2) { const q = queue.shift(); saving += extraKwh * (laterAvg(q[1]) - q[0]); }   // Wärme ist inzwischen verbraucht
      }
    }
    queue.forEach(function (q) { saving += extraKwh * (laterAvg(q[1]) - q[0]); });
    return { shift: shift, moved: r(moved, 2), saving: r(saving, 1), cheapCt: r(cheap, 1), expensiveCt: r(expensive, 1) };
  }

  /* ---------------------------------------------------------------- Planen */

  function replan(why) {
    const live = ctx.live();
    const now = Math.floor(Date.now() / SLOT) * SLOT, until = now + P.horizonHours * 3600000;
    const pr = prices.series(now, until), fc = forecast.series(now, until);
    const lp = loadProfile(), hm = heatModel();
    const slots = pr.map(function (p, i) {
      const f = fc[i] || {}, tempC = f.tempC === undefined ? null : f.tempC;
      const base = lp.profile[slotOfDay(p.t)];
      const heatW = hm.measured && tempC !== null && tempC < hm.limitTemp ? (hm.limitTemp - tempC) * hm.wattsPerKelvin : 0;
      return { t: p.t, buy: p.buy, sell: p.sell, known: p.known, spot: p.spot, pvW: f.pvW === null || f.pvW === undefined ? 0 : f.pvW, tempC: tempC,
        loadW: base + heatW, heatW: heatW, pvKwh: (f.pvW || 0) / 4000, loadKwh: (base + heatW) / 4000 };
    });
    const soc0 = live ? live.inverter.battery.soc : 50, cap = capacity(live);
    const o = optimize(P, slots, soc0, cap);
    const hpl = heatPlan(slots, o.best, hm);
    const unknownFrom = slots.filter(function (s) { return !s.known; })[0];
    S.plan = slots.map(function (s, i) {
      return { t: s.t, buy: r(s.buy, 2), sell: s.sell, spot: s.spot === null ? null : r(s.spot, 2), known: s.known, pvW: Math.round(s.pvW), loadW: Math.round(s.loadW), heatW: Math.round(s.heatW), tempC: s.tempC,
        action: o.actions.charge[i] > 0 ? 'charge' : o.actions.hold[i] ? 'hold' : 'normal', chargeW: Math.round(o.actions.charge[i] * 4000),
        soc: r(o.best.slots[i].soc, 1), socBase: r(o.base.slots[i].soc, 1), impKwh: r(o.best.slots[i].imp, 3), expKwh: r(o.best.slots[i].exp, 3), shift: hpl.shift[i] };
    });
    S.totals = { baseCostEur: r(o.base.cost / 100, 2), planCostEur: r(o.best.cost / 100, 2), savingEur: r((o.gain || 0) / 100, 2), heatSavingEur: r(hpl.saving / 100, 2), heatMovedKwh: hpl.moved,
      moves: o.moves, capacityKwh: cap, soc0: soc0, hours: P.horizonHours, pricesKnownUntil: unknownFrom ? unknownFrom.t : until, loadDays: lp.days, loadLearned: lp.learned,
      heat: { measured: hm.measured, learned: hm.learned, wattsPerKelvin: Math.round(hm.wattsPerKelvin), cheapCt: hpl.cheapCt, expensiveCt: hpl.expensiveCt },
      pvKwh: r(slots.reduce(function (a, s) { return a + s.pvKwh; }, 0), 1), loadKwh: r(slots.reduce(function (a, s) { return a + s.loadKwh; }, 0), 1) };
    S.plannedAt = Date.now(); replanDue = false;
    const day = new Date().toISOString().slice(0, 10);
    S.savings[day] = Object.assign(S.savings[day] || {}, { planned: S.totals.savingEur, heat: S.totals.heatSavingEur, mode: S.mode });
    Object.keys(S.savings).sort().slice(0, -60).forEach(function (k) { delete S.savings[k]; });
    if (why) log('Neu geplant (' + why + '): ' + o.moves + ' Eingriffe, Ersparnis ' + S.totals.savingEur.toFixed(2) + ' € in ' + P.horizonHours + ' h' + (hpl.moved ? ', Wärmepumpe verschiebt ' + hpl.moved + ' kWh' : ''));
  }

  /* ---------------------------------------------------------------- Ausführen */

  function current() {
    if (!S.plan) return null;
    const now = Math.floor(Date.now() / SLOT) * SLOT;
    return S.plan.filter(function (s) { return s.t === now; })[0] || null;
  }

  function wantFor(slot) {
    if (!slot || slot.action === 'normal') return { kind: 'normal' };
    if (slot.action === 'hold') return { kind: 'ruhe' };
    return { kind: 'laden', watts: Math.max(100, Math.min(P.chargeW, Math.round(slot.chargeW / 100) * 100)) };
  }
  function sameWant(a, b) { return !!a && !!b && a.kind === b.kind && (a.watts || 0) === (b.watts || 0); }

  function tick() {
    S.lastTick = Date.now();
    if (S.mode === 'off') return;
    if (replanDue || Date.now() - S.plannedAt > 15 * 60000) { try { replan(replanDue ? 'neue Daten' : 'Viertelstunde'); } catch (e) { log('Planung fehlgeschlagen: ' + e.message); } }
    const slot = current(); if (!slot) return;
    const want = wantFor(slot), live = ctx.live();
    const shift = P.heat.enabled && hp ? slot.shift : 0;
    if (ctx.matchingActive && ctx.matchingActive()) { if (S.pausedWhy !== 'matching') { S.pausedWhy = 'matching'; log('Pause: Matching-Ablauf läuft'); } return; }
    if (!live || Date.now() - (ctx.lastOk() || 0) > 120000) {
      if (S.pausedWhy !== 'nodata') { S.pausedWhy = 'nodata'; log('Pause: keine aktuellen Messwerte'); }
      if (S.mode === 'active' && S.applied && S.applied.kind !== 'normal') applyBattery({ kind: 'normal' });
      if (S.mode === 'active' && hp && S.shift) { hp.setShift(0).catch(function () {}); S.shift = 0; }
      return;
    }
    if (S.pausedWhy) { log('Weiter: ' + (S.pausedWhy === 'matching' ? 'Matching beendet' : 'Messwerte wieder da')); S.pausedWhy = null; }
    if (!sameWant(S.want, want)) { S.want = want; S.wantSince = Date.now(); log((S.mode === 'active' ? 'Batterie: ' : 'Batterie (Simulation): ') + text(want) + ' bis ' + new Date(slot.t + SLOT).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' bei ' + slot.buy.toFixed(1) + ' ct/kWh'); }
    if (shift !== S.shift) { S.shift = shift; log((S.mode === 'active' && hp.state().writeEnabled ? 'Wärmepumpe: ' : 'Wärmepumpe (Simulation): ') + 'Verschiebung ' + (shift > 0 ? '+' : '') + shift + ' K'); }
    if (S.mode !== 'active') return;
    if (!S.applied && matches(live.settings, want)) { S.applied = want; S.appliedAt = Date.now(); }       // steht schon so, nichts schreiben
    else if (!sameWant(S.applied, want) || (want.kind !== 'normal' && !matches(live.settings, want) && Date.now() - (S.appliedAt || 0) > 60000)) applyBattery(want);
    if (hp && hp.state().writeEnabled) hp.setShift(shift).catch(function () {});        // schreibt nur bei Änderung
  }

  function text(w) { return w.kind === 'normal' ? 'Eigenverbrauch' : w.kind === 'ruhe' ? 'schonen (nicht entladen)' : 'aus dem Netz laden mit ' + w.watts + ' W'; }
  function matches(st, want) {
    if (!st) return false;
    if (want.kind === 'normal') return st.emsMode === 'Eigenverbrauch';
    if (st.emsMode !== 'Zwangsmodus') return false;
    if (want.kind === 'ruhe') return st.forcedCommand === 'Stopp';
    return st.forcedCommand === 'Laden' && st.forcedPowerW === want.watts;
  }
  function applyBattery(want) {
    S.applied = want; S.appliedAt = Date.now();
    return ctx.applyEms(want).then(function () { log('Wechselrichter gesetzt: ' + text(want)); }, function (e) { log('Schreiben fehlgeschlagen: ' + e.message); S.applied = null; });
  }

  function setMode(mode) {
    if (['off', 'simulate', 'active'].indexOf(mode) < 0) return 'Unbekannte Betriebsart';
    const old = S.mode; S.mode = mode;
    if (ctx.saveMode) ctx.saveMode(mode);
    log('Betriebsart: ' + ({ off: 'aus', simulate: 'Simulation', active: 'aktiv' })[mode]);
    if (old === 'active' && mode !== 'active') { if (S.applied && S.applied.kind !== 'normal') applyBattery({ kind: 'normal' }); if (hp && hp.state().writeEnabled) hp.setShift(0).catch(function () {}); S.shift = 0; }
    S.applied = null; S.want = null; replanDue = true;
    if (mode !== 'off') tick();
    return null;
  }

  function stop() {
    if (timer) clearInterval(timer);
    const ps = [];
    if (S.mode === 'active' && S.applied && S.applied.kind !== 'normal') ps.push(ctx.applyEms({ kind: 'normal' }).catch(function () {}));
    if (hp) ps.push(hp.stop(S.mode === 'active'));
    return Promise.all(ps);
  }

  /* Wochenausblick: je Tag PV, Temperatur, erwarteter Verbrauch (Lastprofil plus Heizlast), Heiztag ja/nein, mittlerer Preis */
  function outlook() {
    const days = forecast.daily(7), lp = loadProfile(), hm = heatModel();
    const baseDay = lp.profile.reduce(function (a, w) { return a + w / 4000; }, 0);
    return days.map(function (d) {
      const heating = d.tAvg !== null && d.tAvg < hm.limitTemp;
      const heatKwh = heating && hm.measured ? Math.round((hm.limitTemp - d.tAvg) * hm.wattsPerKelvin * 24 / 1000 * 10) / 10 : 0;
      const de = new Date(d.t); de.setDate(de.getDate() + 1); const pr = prices.series(d.t, de.getTime());
      const avg = pr.length ? pr.reduce(function (a, p) { return a + p.buy; }, 0) / pr.length : null;
      const known = pr.length ? pr.filter(function (p) { return p.known; }).length / pr.length : 0;
      return { day: d.day, t: d.t, pvKwh: d.pvKwh, tMin: d.tMin, tMax: d.tMax, tAvg: d.tAvg, loadKwh: Math.round((baseDay + heatKwh) * 10) / 10, heatKwh: heatKwh, heating: heating,
        priceCt: avg === null ? null : Math.round(avg * 10) / 10, priceKnown: known, surplusKwh: d.pvKwh === null ? null : Math.round((d.pvKwh - baseDay - heatKwh) * 10) / 10 };
    });
  }

  function view() {
    const slot = current();
    let ol = null; try { ol = outlook(); } catch (e) { ol = null; }
    return { mode: S.mode, plannedAt: S.plannedAt, plan: S.plan, totals: S.totals, now: slot, want: S.want ? text(S.want) : null, applied: S.applied ? text(S.applied) : null, shift: S.shift,
      pausedWhy: S.pausedWhy, log: S.log.slice(-80), savings: S.savings, params: P, outlook: ol,
      prices: prices.state(), forecast: forecast.state(), heatpump: hp ? hp.state() : null };
  }

  return {
    start: function () { timer = setInterval(tick, Math.max(10, P.tickSeconds) * 1000); setTimeout(tick, 5000); },
    stop: stop, tick: tick, view: view, setMode: setMode, invalidate: function () { replanDue = true; }, replan: function () { replan('von Hand'); }, isActive: function () { return S.mode === 'active'; }
  };
};
module.exports.DEFAULTS = DEFAULTS;
module.exports.simulate = simulate;
module.exports.optimize = optimize;
