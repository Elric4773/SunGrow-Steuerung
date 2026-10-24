/*
 * Sungrow Steuerung – Energiefluss (gemeinsame Grafik für Planer und Anlage)
 * (C) by Elric M.
 * Nur für die private Nutzung zu Test- und Lernzwecken. Kommerzielle Verwendung jeder Art, die Verwendung im
 * Geschäftsbetrieb und der Weiterverkauf sind untersagt. Benutzung auf eigene Gefahr, ohne Gewährleistung oder Garantie.
 * Einzelheiten: LICENSE und HANDBUCH.md.
 */
/* Flow.resolve(opts) rechnet aus Live-Daten und der Quellenwahl (cfg.flow) die Knotenwerte aus,
   Flow.render(svg, data) zeichnet sie. Quellenwahl:
     house:    'auto' | 'inverter' | 'meter:<Name>'
     heatpump: 'auto' | 'none' | 'register' | 'meter:<Name>'
     car:      'auto' | 'none' | 'meter:<Name>'
   'auto' = gemessener Zähler mit passender Rolle, sonst Wechselrichter bzw. Wärmepumpenregler. */
(function () {
  'use strict';
  var FRESH = 5 * 60000;
  function esc(s) { return String(s === undefined || s === null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function nf(v, d) { return (v === null || v === undefined || isNaN(v)) ? '–' : Number(v).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }); }
  function kw(w) { return nf(Math.abs(w) / 1000, Math.abs(w) < 10000 ? 2 : 1) + ' kW'; }

  function resolve(opts) {
    var flow = opts.flow || {}, L = opts.live || {}, inv = L.live || null, M = L.meters || [], hp = opts.heatpump || L.heatpump || null;
    var now = Date.now();
    var fresh = function (m) { return m && m.fresh !== false && m.watts !== null && m.watts !== undefined; };
    var byName = function (n) { var l = M.filter(function (x) { return x.name === n; }); return l.length ? l[0] : null; };
    var sumRole = function (r) { var l = M.filter(function (x) { return x.role === r && fresh(x); }); return l.length ? l.reduce(function (a, x) { return a + x.watts; }, 0) : null; };
    var pick = function (sel, role) {          // -> { w, state, name } ; state: measured | stale | inverter | register | none
      if (sel === 'none') return { w: null, state: 'none' };
      if (sel && sel.indexOf('meter:') === 0) { var m = byName(sel.slice(6)); if (!m) return { w: null, state: 'missing', name: sel.slice(6) }; return fresh(m) ? { w: m.watts, state: 'measured', name: m.name } : { w: null, state: 'stale', name: m.name }; }
      if (sel === 'auto' || !sel) { var s = sumRole(role); if (s !== null) return { w: s, state: 'measured', name: M.filter(function (x) { return x.role === role; }).map(function (x) { return x.name; }).join(' + ') }; }
      return null;
    };
    var pv = inv ? inv.plant.pvPower : 0, pvExtra = inv && inv.plant.pvExtra ? inv.plant.pvExtra : 0, grid = inv ? inv.inverter.gridPower : 0;
    var bat = inv ? inv.inverter.battery.power : 0, soc = inv ? inv.inverter.battery.soc : null;
    /* Haus */
    var h = pick(flow.house, 'house'), house = inv ? inv.plant.loadPower : 0, houseSrc = 'inverter';
    if (h && h.state === 'measured') { house = h.w + pvExtra; houseSrc = h.name; }
    /* Wärmepumpe */
    var hpsel = flow.heatpump || 'auto', H = pick(hpsel, 'heatpump'), hpW = 0, hpState = 'none', hpName = '';
    var hpFresh = hp && hp.live && now - hp.at < 10 * FRESH / 5, hv = hpFresh ? hp.live.values : {};
    if (H && H.state === 'measured') { hpW = H.w; hpState = 'measured'; hpName = H.name; }
    else if (H && (H.state === 'stale' || H.state === 'missing')) { hpState = H.state; hpName = H.name; }
    else if (hpsel === 'none') hpState = 'none';
    else if (hp) {                                   // auto ohne Zähler oder ausdrücklich 'register'
      hpName = hp.name || 'Regler';
      if (!hpFresh) hpState = 'novals';
      else if (hv.elPower !== undefined) { hpW = hv.elPower; hpState = 'register'; }
      else if (hp.live.running) { var hm = opts.heatModel; hpW = hm && hm.wattsPerKelvin ? Math.max(600, hm.wattsPerKelvin * Math.max(1, (hm.limitTemp || 15) - (hv.outdoorTemp || 5))) : 1500; hpState = 'estimate'; }
      else { hpW = 0; hpState = 'off'; }
    } else hpState = hpsel === 'register' ? 'noreg' : 'none';
    /* E-Auto */
    var C = pick(flow.car || 'auto', 'car'), carW = null, carState = 'none', carName = '';
    if (C && C.state === 'measured') { carW = C.w; carState = 'measured'; carName = C.name; }
    else if (C && (C.state === 'stale' || C.state === 'missing')) { carState = C.state; carName = C.name; }
    /* freie Verbraucher (Anzeige als Liste) */
    var used = {}; if (h && h.name) h.name.split(' + ').forEach(function (n) { used[n] = 1; }); [hpName, carName].forEach(function (n) { if (n) n.split(' + ').forEach(function (x) { used[x] = 1; }); });
    var extras = M.filter(function (x) { return !used[x.name] && x.role !== 'pv' && !(x.role === 'house' && houseSrc !== 'inverter'); }).map(function (x) { return { name: x.name, w: fresh(x) ? x.watts : null, role: x.roleLabel || x.role }; });
    return { ok: !!inv, at: L.lastOk || null, pv: pv, pvExtra: pvExtra, grid: grid, bat: bat, soc: soc, house: house, houseSrc: houseSrc,
      hp: { w: hpW, state: hpState, name: hpName }, car: { w: carW, state: carState, name: carName }, extras: extras };
  }

  function render(svg, d) {
    var hasHp = d.hp.state !== 'none' && d.hp.state !== 'noreg';
    /* Haus zeigt den Rest ohne Wärmepumpe und E-Auto; die Summe steht klein darunter */
    var split = (hasHp && d.hp.w > 0 ? d.hp.w : 0) + (d.car.w !== null && d.car.w > 0 ? d.car.w : 0), rest = Math.max(0, d.house - split);
    var hpText = { measured: kw(d.hp.w), register: kw(d.hp.w), estimate: '≈ ' + kw(d.hp.w), off: 'steht', novals: 'keine Werte', stale: 'keine Werte', missing: 'Zähler fehlt', none: 'nicht eingerichtet', noreg: 'kein Regler' }[d.hp.state] || '–';
    var carText = { measured: d.car.w === null ? '–' : kw(d.car.w), stale: 'keine Werte', missing: 'Zähler fehlt', none: 'nicht gemessen' }[d.car.state] || '–';
    var N = { solar: { x: 70, y: 48, c: 'var(--pv)', t: 'Solar', v: d.pv > 0 ? kw(d.pv) : '–', v2: d.pvExtra ? 'davon Erzeuger ' + kw(d.pvExtra) : '' },
      grid: { x: 290, y: 48, c: 'var(--grid)', t: 'Netz', v: d.grid ? kw(d.grid) + (d.grid > 0 ? ' Bezug' : ' Einsp.') : '0 kW' },
      house: { x: 180, y: 150, c: 'var(--ink)', t: 'Haus', v: kw(split > 20 ? rest : d.house), v2: split > 20 ? 'gesamt ' + kw(d.house) : '' },
      batt: { x: 70, y: 245, c: 'var(--batt)', t: 'Batterie', v: (d.soc !== null ? nf(d.soc, 0) + ' %' : '–') + (d.bat ? ' · ' + kw(d.bat) + (d.bat > 0 ? ' lädt' : ' entlädt') : '') },
      hp: { x: 290, y: 245, c: 'var(--heat)', t: 'Wärme-\npumpe', v: hpText },
      car: { x: 180, y: 258, c: 'var(--muted)', t: 'E-Auto', v: carText } };
    var out = '<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>';
    var edge = function (a, b, w, color) {
      if (!(Math.abs(w) > 20)) return '';
      var from = w > 0 ? N[a] : N[b], to = w > 0 ? N[b] : N[a], sw = Math.max(2, Math.min(10, Math.abs(w) / 800));
      var dx = to.x - from.x, dy = to.y - from.y, len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len;
      var x1 = from.x + ux * 34, y1 = from.y + uy * 34, x2 = to.x - ux * 36, y2 = to.y - uy * 36;
      return '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="' + color + '" stroke-width="' + (sw + 4) + '" opacity=".18" stroke-linecap="round"/>' +
        '<line class="flowline" x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="' + color + '" stroke-width="' + sw + '" stroke-dasharray="10 14" stroke-linecap="round" style="color:' + color + '" marker-end="url(#arr)"/>';
    };
    var pv = d.pv, bat = d.bat, grid = d.grid;
    var pvToBat = Math.max(0, Math.min(pv, bat)), pvToGrid = Math.max(0, Math.min(pv - pvToBat, -grid)), pvToHouse = Math.max(0, pv - pvToBat - pvToGrid);
    out += edge('solar', 'house', pvToHouse, 'var(--pv)') + edge('solar', 'batt', pvToBat, 'var(--pv)') + edge('solar', 'grid', pvToGrid, 'var(--pv)');
    out += edge('grid', 'house', Math.max(0, grid), 'var(--grid)') + edge('batt', 'house', Math.max(0, -bat), 'var(--batt)') + edge('grid', 'batt', Math.max(0, bat - pvToBat), 'var(--grid)');
    if (hasHp && d.hp.w > 0) out += edge('house', 'hp', d.hp.w, 'var(--heat)');
    if (d.car.w !== null && d.car.w > 20) out += edge('house', 'car', d.car.w, 'var(--grid)');
    Object.keys(N).forEach(function (k) {
      var o = N[k], dim = (k === 'car' && d.car.state !== 'measured') || (k === 'hp' && !hasHp);
      out += '<g class="node" opacity="' + (dim ? '.45' : '1') + '"><circle cx="' + o.x + '" cy="' + o.y + '" r="30" fill="var(--panel)" stroke="' + o.c + '" stroke-width="3"/>' +
        (k === 'batt' && d.soc !== null ? '<rect x="' + (o.x - 18) + '" y="' + (o.y + 10) + '" width="36" height="7" rx="2" fill="var(--track)"/><rect x="' + (o.x - 18) + '" y="' + (o.y + 10) + '" width="' + (36 * d.soc / 100) + '" height="7" rx="2" fill="' + o.c + '"/>' : '') +
        (o.t.indexOf('\n') >= 0 ? '<text x="' + o.x + '" y="' + (o.y - 1) + '" text-anchor="middle" font-size="13" font-weight="600" fill="var(--ink)">' + esc(o.t.split('\n')[0]) + '</text><text x="' + o.x + '" y="' + (o.y + 13) + '" text-anchor="middle" font-size="13" font-weight="600" fill="var(--ink)">' + esc(o.t.split('\n')[1]) + '</text>'
          : '<text x="' + o.x + '" y="' + (o.y + (k === 'batt' ? 2 : 5)) + '" text-anchor="middle" font-size="13" font-weight="600" fill="var(--ink)">' + esc(o.t) + '</text>') +
        (k === 'house' ? '<text x="' + (o.x - 38) + '" y="' + (o.y + (o.v2 ? -2 : 5)) + '" text-anchor="end" font-size="14" fill="var(--muted)">' + esc(o.v) + '</text>' + (o.v2 ? '<text x="' + (o.x - 38) + '" y="' + (o.y + 13) + '" text-anchor="end" font-size="11" fill="var(--muted)">' + esc(o.v2) + '</text>' : '')
          : '<text x="' + o.x + '" y="' + (o.y + 44) + '" text-anchor="middle" font-size="14" fill="var(--muted)">' + esc(o.v) + '</text>' + (o.v2 ? '<text x="' + o.x + '" y="' + (o.y + 59) + '" text-anchor="middle" font-size="11" fill="var(--muted)">' + esc(o.v2) + '</text>' : '')) + '</g>';
    });
    svg.innerHTML = out;
  }

  /* Textzeile zur Herkunft der Werte, z. B. für die Vorschau auf der Seite Anlage */
  function describe(d) {
    var hp = { measured: 'Zähler ' + d.hp.name, register: 'Regler ' + d.hp.name, estimate: 'Regler ' + d.hp.name + ' (geschätzt)', off: 'Regler ' + d.hp.name, novals: 'Regler ' + d.hp.name + ', keine Werte', stale: 'Zähler ' + d.hp.name + ', keine Werte', missing: 'Zähler „' + d.hp.name + '“ fehlt', none: 'nicht eingerichtet', noreg: 'kein Regler eingerichtet' }[d.hp.state];
    var car = { measured: 'Zähler ' + d.car.name, stale: 'Zähler ' + d.car.name + ', keine Werte', missing: 'Zähler „' + d.car.name + '“ fehlt', none: 'nicht gemessen' }[d.car.state];
    return { house: d.houseSrc === 'inverter' ? 'Wechselrichter' + (d.pvExtra ? ' + Erzeuger' : '') : 'Zähler ' + d.houseSrc + (d.pvExtra ? ' + Erzeuger' : ''), heatpump: hp, car: car };
  }

  window.Flow = { resolve: resolve, render: render, describe: describe, kw: kw };
})();
