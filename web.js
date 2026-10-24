'use strict';
/*
 * Sungrow Steuerung – (C) by Elric M.
 * Nur für die private Nutzung zu Test- und Lernzwecken. Kommerzielle Verwendung jeder Art, die Verwendung im
 * Geschäftsbetrieb und der Weiterverkauf sind untersagt. Benutzung auf eigene Gefahr, ohne Gewährleistung oder Garantie.
 * Einzelheiten: LICENSE und HANDBUCH.md.
 */
/* Kleiner HTTP(S)-Abruf für JSON-Schnittstellen (Strombörse, Wetter, PV-Prognose). Ohne fremde Pakete. */
const http = require('http');
const https = require('https');

/* opts: { auth: 'user:pass' } für HTTP Basic (z. B. Loxone Miniserver); text: true liefert den Rohtext statt JSON */
function fetchJson(url, timeoutMs, hops, opts) {
  hops = hops || 0; opts = opts || {};
  return new Promise(function (resolve, reject) {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('ungültige Adresse: ' + url)); }
    const lib = u.protocol === 'https:' ? https : http;
    const headers = { 'User-Agent': 'sungrow-steuerung/1.0', Accept: opts.text ? '*/*' : 'application/json' };
    if (opts.auth) headers.Authorization = 'Basic ' + Buffer.from(opts.auth).toString('base64');
    const req = lib.get(u, { headers: headers, rejectUnauthorized: false }, function (res) {
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) && res.headers.location && hops < 2) {
        res.resume();
        return fetchJson(new URL(res.headers.location, u).toString(), timeoutMs, hops + 1, opts).then(resolve, reject);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', function (c) { body += c; if (body.length > 4000000) { req.destroy(new Error('Antwort zu groß')); } });
      res.on('end', function () {
        if (res.statusCode === 401) return reject(new Error(u.host + ': Anmeldung abgelehnt (Benutzer/Passwort)'));
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('HTTP ' + res.statusCode + ' von ' + u.host + (body ? ': ' + body.slice(0, 120).replace(/\s+/g, ' ') : '')));
        if (res.statusCode === 401) return reject(new Error(u.host + ': Anmeldung abgelehnt (Benutzer/Passwort)'));
        if (opts.text) return resolve(body);
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('keine gültige JSON-Antwort von ' + u.host)); }
      });
    });
    req.setTimeout(timeoutMs || 15000, function () { req.destroy(new Error('Zeitüberschreitung bei ' + u.host)); });
    req.on('error', function (e) { reject(new Error(u.host + ': ' + (e.code === 'ENOTFOUND' ? 'Name nicht auflösbar (kein Internet?)' : e.message))); });
  });
}

module.exports = { fetchJson: fetchJson };
