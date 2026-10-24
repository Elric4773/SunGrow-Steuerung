/* Sungrow Steuerung – (C) by Elric M. – nur private Nutzung zu Test- und Lernzwecken, siehe LICENSE
   Skin-Wahl: merkt sich die Farbwelt je Browser (localStorage) und hängt die Auswahl ins Menü. */
(function () {
  'use strict';
  var SKINS = [['auto', 'Wie das System'], ['hell', 'Hell'], ['dunkel', 'Dunkel'], ['nacht', 'Nacht'], ['sand', 'Sand']];
  var KEY = 'sungrow-skin';
  function get() { try { return localStorage.getItem(KEY) || 'auto'; } catch (e) { return 'auto'; } }
  function apply(v) {
    if (v === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', v);
    try { if (v === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, v); } catch (e) { /* privater Modus */ }
  }
  apply(get());
  function label(v) { for (var i = 0; i < SKINS.length; i++) if (SKINS[i][0] === v) return SKINS[i][1]; return 'Skin'; }
  function build() {
    var nav = document.querySelector('nav.top') || document.querySelector('header nav[role="tablist"]');
    if (!nav || nav.querySelector('.skin')) return;
    var box = document.createElement('div'); box.className = 'skin';
    var btn = document.createElement('button'); btn.type = 'button'; btn.setAttribute('aria-haspopup', 'menu'); btn.setAttribute('aria-expanded', 'false');
    var menu = document.createElement('menu'); menu.hidden = true; menu.setAttribute('role', 'menu');
    function paint() { btn.innerHTML = '<span class="sw"></span>' + label(get()); }
    SKINS.forEach(function (s) {
      var li = document.createElement('li'), b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'menuitemradio');
      b.innerHTML = '<span class="sw ' + s[0] + '"></span>' + s[1];
      b.onclick = function () { apply(s[0]); paint(); mark(); close(); };
      li.appendChild(b); menu.appendChild(li);
    });
    function mark() { var cur = get(); Array.prototype.forEach.call(menu.querySelectorAll('button'), function (b, i) { b.setAttribute('aria-checked', String(SKINS[i][0] === cur)); }); }
    function close() { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
    btn.onclick = function (e) { e.stopPropagation(); menu.hidden = !menu.hidden; btn.setAttribute('aria-expanded', String(!menu.hidden)); mark(); };
    document.addEventListener('click', close);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    paint(); mark();
    // Schnellumschalter hell/dunkel: springt zwischen Hell und Dunkel, aus "Wie das System" heraus zur jeweils anderen Seite
    var hd = document.createElement('button'); hd.type = 'button'; hd.className = 'hd'; hd.title = 'Hell / Dunkel umschalten';
    function isDark() { var t = get(); if (t === 'dunkel' || t === 'nacht') return true; if (t === 'hell' || t === 'sand') return false; return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches; }
    function paintHd() { hd.textContent = isDark() ? '\u2600' : '\u263D'; hd.setAttribute('aria-label', isDark() ? 'Auf hell umschalten' : 'Auf dunkel umschalten'); }
    hd.onclick = function (e) { e.stopPropagation(); apply(isDark() ? 'hell' : 'dunkel'); paint(); paintHd(); mark(); };
    paintHd();
    box.appendChild(hd); box.appendChild(btn); box.appendChild(menu);
    var copy = nav.querySelector('.copy');
    if (copy) nav.insertBefore(box, copy); else nav.appendChild(box);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();
