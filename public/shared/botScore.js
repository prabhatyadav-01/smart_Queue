/**
 * Behavioural bot detection from pointer / keyboard telemetry.
 *
 * Shared by the server (authoritative verdict) and the browser (live
 * "human signal" meter). UMD so it loads via require() and a <script> tag.
 *
 * Telemetry shape (all timestamps are ms relative to page load):
 *   { moves: [[t,x,y]...], clicks: [[t,x,y]...], keys: [t...],
 *     touches: n, untrusted: n, webdriver: bool, dwellMs: n }
 * Key *values* are never collected — only timing.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BotScore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = { moves: 400, clicks: 60, keys: 200 };
  var HUMAN = 0.6;
  var SUSPICIOUS = 0.35;
  var MIN_EVIDENCE_WEIGHT = 2;

  function clamp01(v) {
    return Math.max(0, Math.min(1, v));
  }
  function mean(a) {
    var s = 0;
    for (var i = 0; i < a.length; i++) s += a[i];
    return a.length ? s / a.length : 0;
  }
  function coeffVar(a) {
    if (a.length < 2) return 0;
    var m = mean(a);
    if (m <= 0) return 0;
    var v = 0;
    for (var i = 0; i < a.length; i++) v += (a[i] - m) * (a[i] - m);
    return Math.sqrt(v / a.length) / m;
  }

  function cleanSeries(arr, max, arity) {
    if (!Array.isArray(arr)) return [];
    var out = [];
    var lastT = -Infinity;
    var src = arr.slice(-max);
    for (var i = 0; i < src.length; i++) {
      var p = arity === 1 ? [src[i]] : src[i];
      if (!Array.isArray(p) || p.length < arity) continue;
      var ok = true;
      for (var k = 0; k < arity; k++) if (typeof p[k] !== 'number' || !isFinite(p[k])) ok = false;
      if (!ok || p[0] < lastT) continue;
      lastT = p[0];
      out.push(p.slice(0, arity));
    }
    return out;
  }

  function component(value, weight, name) {
    return { value: clamp01(value), weight: weight, name: name };
  }

  function moveSignals(moves) {
    if (moves.length < 15) return [];
    var segs = [];
    for (var i = 1; i < moves.length; i++) {
      var dx = moves[i][1] - moves[i - 1][1];
      var dy = moves[i][2] - moves[i - 1][2];
      segs.push({ dx: dx, dy: dy, dt: moves[i][0] - moves[i - 1][0], d: Math.hypot(dx, dy) });
    }
    var speeds = [];
    var dts = [];
    var pathLen = 0;
    var teleports = 0;
    segs.forEach(function (s) {
      pathLen += s.d;
      if (s.dt > 0) dts.push(s.dt);
      if (s.dt > 0 && s.d > 0) speeds.push(s.d / s.dt);
      if (s.d > 250 && s.dt < 16) teleports++;
    });

    var turns = 0;
    var collinear = 0;
    var sameStep = 0;
    for (var j = 1; j < segs.length; j++) {
      var a = segs[j - 1];
      var b = segs[j];
      if (a.d > 0 && a.dx === b.dx && a.dy === b.dy) sameStep++;
      if (a.d < 0.5 || b.d < 0.5) continue;
      turns++;
      if (Math.abs((a.dx * b.dy - a.dy * b.dx) / (a.d * b.d)) < 0.01) collinear++;
    }
    var collinearRatio = turns ? collinear / turns : 1;
    var sameStepRatio = sameStep / Math.max(1, segs.length - 1);
    var first = moves[0];
    var last = moves[moves.length - 1];
    var displacement = Math.hypot(last[1] - first[1], last[2] - first[2]);

    var out = [
      component((coeffVar(speeds) - 0.15) / 0.45, 2, 'uniform-speed'),
      component(1 - (collinearRatio - 0.5) / 0.45, 2, 'perfectly-straight-moves'),
      component(1 - (sameStepRatio - 0.3) / 0.5, 1.5, 'repeated-identical-steps'),
      component(coeffVar(dts) / 0.3, 1, 'metronomic-timing'),
    ];
    if (displacement > 50) out.push(component((pathLen / displacement - 1.01) / 0.15, 1, 'no-path-curvature'));
    if (teleports > 2) out.push(component(0, 1.5, 'cursor-teleports'));
    return out;
  }

  function keySignals(keys) {
    if (keys.length < 8) return [];
    var gaps = [];
    for (var i = 1; i < keys.length; i++) {
      var g = keys[i][0] - keys[i - 1][0];
      if (g > 0 && g < 2000) gaps.push(g);
    }
    if (gaps.length < 6) return [];
    var tooFast = gaps.filter(function (g) { return g < 12; }).length / gaps.length;
    var out = [component((coeffVar(gaps) - 0.05) / 0.3, 1.5, 'robotic-keystroke-rhythm')];
    if (tooFast > 0.5) out.push(component(0, 1.5, 'inhuman-typing-speed'));
    return out;
  }

  function clickSignals(clicks, moves, touches) {
    if (!clicks.length || touches > 0) return [];
    var warm = 0;
    clicks.forEach(function (c) {
      for (var i = moves.length - 1; i >= 0; i--) {
        var m = moves[i];
        if (m[0] > c[0]) continue;
        if (c[0] - m[0] > 800) break;
        if (Math.hypot(m[1] - c[1], m[2] - c[2]) < 40) {
          warm++;
          break;
        }
      }
    });
    return [component(warm / clicks.length, 1.5, 'clicks-without-approach')];
  }

  function analyze(input) {
    if (!input || typeof input !== 'object') {
      return { score: 0.5, verdict: 'inconclusive', hard: false, reasons: ['no-telemetry'], samples: 0 };
    }
    if (input.webdriver === true) {
      return { score: 0.02, verdict: 'bot', hard: true, reasons: ['automation-flag'], samples: 0 };
    }
    if (Number(input.untrusted) >= 3) {
      return { score: 0.05, verdict: 'bot', hard: true, reasons: ['synthetic-events'], samples: 0 };
    }
    var moves = cleanSeries(input.moves, LIMITS.moves, 3);
    var clicks = cleanSeries(input.clicks, LIMITS.clicks, 3);
    var keys = cleanSeries(input.keys, LIMITS.keys, 1);
    var touches = Math.max(0, Number(input.touches) || 0);
    var dwell = Number(input.dwellMs) || 0;

    var comps = []
      .concat(moveSignals(moves))
      .concat(keySignals(keys))
      .concat(clickSignals(clicks, moves, touches));
    if (touches >= 3) comps.push(component(0.8, 1.2, 'touch'));
    if (dwell > 0 && dwell < 800) comps.push(component(0, 1, 'submitted-too-fast'));

    var weight = 0;
    var sum = 0;
    comps.forEach(function (c) {
      weight += c.weight;
      sum += c.value * c.weight;
    });
    var reasons = comps.filter(function (c) { return c.value < 0.4; }).map(function (c) { return c.name; });
    if (weight < MIN_EVIDENCE_WEIGHT) {
      return { score: 0.5, verdict: 'inconclusive', hard: false, reasons: reasons.concat('not-enough-signal'), samples: moves.length };
    }
    var score = Math.round((sum / weight) * 100) / 100;
    var verdict = score >= HUMAN ? 'human' : score >= SUSPICIOUS ? 'suspicious' : 'bot';
    return { score: score, verdict: verdict, hard: false, reasons: reasons, samples: moves.length };
  }

  return { analyze: analyze, LIMITS: LIMITS, HUMAN: HUMAN, SUSPICIOUS: SUSPICIOUS };
});
