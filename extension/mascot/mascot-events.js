/*
 * KidGuard mascot - event bridge + public API bootstrap.
 *
 * Primary channel (Person B's frozen contract, content.js):
 *   document.addEventListener('kidguard:mascot', e => e.detail)
 *   detail = { mood: 'idle'|'worry'|'happy'|'point', x, y, targetRect|null }
 *   targetRect = { top, left, width, height }
 *   plus window.__KIDGUARD__.onMascot(cb) in the same isolated world.
 *
 * Additionally tolerated (so a different producer also works):
 *   window.addEventListener('kidguard:mascot', ...)
 *   detail = { action, mood, message, targetRect: { x, y, width, height } }
 *
 * Everything is normalised to { mood, x, y, rect, message } and an unknown mood
 * falls back to 'idle'. Nothing in content.js is modified or required to change.
 */
(function () {
  "use strict";

  var NS = (window.KidGuardMascotNS = window.KidGuardMascotNS || {});
  if (NS.eventsLoaded) return;
  NS.eventsLoaded = true;

  var EVENT = "kidguard:mascot";
  var MOODS = { idle: 1, worry: 1, happy: 1, point: 1 };

  var ACTION_MOOD = {
    allow: "happy",
    allow_page: "happy",
    safe: "happy",
    ok: "happy",
    happy: "happy",
    celebrate: "happy",
    warn: "worry",
    warn_kid: "worry",
    warning: "worry",
    caution: "worry",
    suspicious: "worry",
    block: "worry",
    block_page: "worry",
    danger: "worry",
    worry: "worry",
    highlight: "point",
    highlight_element: "point",
    point: "point",
    point_at: "point",
    look: "point",
    idle: "idle",
    reset: "idle"
  };

  function normalise(detail) {
    if (!detail || typeof detail !== "object") return null;
    var mood = typeof detail.mood === "string" ? detail.mood.toLowerCase().trim() : "";
    if (!MOODS[mood]) {
      var action = typeof detail.action === "string" ? detail.action.toLowerCase().trim() : "";
      mood = ACTION_MOOD[action] || "";
    }
    var rect = NS.normaliseRect ? NS.normaliseRect(detail.targetRect || detail.rect || null) : null;
    if (!MOODS[mood]) mood = rect ? "point" : "idle"; // unknown mood -> safe default
    var msg = detail.message || detail.text || detail.kid_message || "";
    return {
      mood: mood,
      x: typeof detail.x === "number" && isFinite(detail.x) ? detail.x : null,
      y: typeof detail.y === "number" && isFinite(detail.y) ? detail.y : null,
      rect: rect,
      message: typeof msg === "string" ? msg : ""
    };
  }
  NS.normaliseDetail = normalise;

  /* --------------------------------------------------- public façade + queue */

  var queue = [];
  function call(name, args) {
    var c = NS.controller;
    if (c && typeof c[name] === "function") return c[name].apply(c, args);
    if (queue.length < 40) queue.push([name, args]);
    return undefined;
  }
  function drain() {
    var c = NS.controller;
    if (!c) return;
    var q = queue.slice();
    queue.length = 0;
    for (var i = 0; i < q.length; i++) {
      try {
        c[q[i][0]].apply(c, q[i][1]);
      } catch (e) {}
    }
  }

  // window.KidGuardMascot exists immediately; calls made before the renderer is
  // up are replayed once it is. window.__KIDGUARD__ is left untouched.
  var facade = {
    show: function () {
      return call("show", []);
    },
    hide: function () {
      return call("hide", []);
    },
    setMood: function (mood) {
      return call("setMood", [MOODS[mood] ? mood : "idle"]);
    },
    setMessage: function (text, ms) {
      return call("setMessage", [text, ms]);
    },
    pointToElement: function (el, opts) {
      return call("pointToElement", [el, opts]);
    },
    pointToCoordinates: function (x, y, opts) {
      return call("pointToCoordinates", [x, y, opts]);
    },
    setMinimised: function (v) {
      return call("setMinimised", [v]);
    },
    reset: function () {
      return call("reset", []);
    },
    destroy: function () {
      var c = NS.controller;
      queue.length = 0;
      if (c) c.destroy();
    },
    onStatus: function (cb) {
      return call("onStatus", [cb]);
    },
    getMood: function () {
      var c = NS.controller;
      return c ? c.getMood() : "idle";
    },
    get state() {
      var c = NS.controller;
      return c ? c.state : { mood: "idle", ready: false, error: "renderer not started" };
    },
    isReady: function () {
      return !!NS.controller;
    }
  };
  if (!window.KidGuardMascot) window.KidGuardMascot = facade;

  /* ------------------------------------------------------------- listeners */

  var lastSig = "";
  var lastAt = 0;

  function handle(detail) {
    var d = normalise(detail);
    if (!d) return;
    // content.js fires the DOM event *and* its own subscribers; and a producer
    // may bubble the same event up to window. Collapse those duplicates.
    var sig = d.mood + "|" + d.x + "," + d.y + "|" + (d.rect ? d.rect.top + "," + d.rect.left + "," + d.rect.width : "-") + "|" + d.message;
    var t = Date.now();
    if (sig === lastSig && t - lastAt < 80) return;
    lastSig = sig;
    lastAt = t;

    var c = NS.controller;
    if (!c) {
      queue.push(["setMood", [d.mood]]);
      return;
    }
    if (d.mood === "point") {
      // No usable rect: still adopt the pointing pose rather than doing nothing.
      c.pointToRect(d.rect, { message: d.message, fallbackMood: "point" });
    } else {
      c.setMood(d.mood);
      if (d.rect) c.setAvoidRect(d.rect);
      if (d.message) c.setMessage(d.message);
    }
  }

  function onDomEvent(e) {
    handle(e && e.detail);
  }

  var unsubscribe = null;
  var attached = false;

  function attach() {
    if (attached) return;
    attached = true;
    document.addEventListener(EVENT, onDomEvent, false);
    window.addEventListener(EVENT, onDomEvent, false);
    var K = window.__KIDGUARD__;
    if (K && typeof K.onMascot === "function") {
      try {
        unsubscribe = K.onMascot(handle);
      } catch (e) {}
    }
  }

  NS.detachEvents = function () {
    if (!attached) return;
    attached = false;
    document.removeEventListener(EVENT, onDomEvent, false);
    window.removeEventListener(EVENT, onDomEvent, false);
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch (e) {}
      unsubscribe = null;
    }
  };

  /* ------------------------------------------------------------- bootstrap */

  var tries = 0;
  function boot() {
    if (NS.controller) return;
    var ctl = null;
    try {
      ctl = NS.createController();
    } catch (err) {
      if (window.console && console.debug) console.debug("[KidGuard mascot] init failed", err);
    }
    if (ctl) {
      attach();
      // Seed with whatever the page already decided before we were ready.
      try {
        var K = window.__KIDGUARD__;
        var rect = K && typeof K.getHighlightRect === "function" ? K.getHighlightRect() : null;
        if (rect) ctl.setAvoidRect(rect);
      } catch (e) {}
      drain();
      return;
    }
    tries++;
    if (tries < 40) setTimeout(boot, tries < 10 ? 120 : 500);
  }

  NS.boot = boot;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
    setTimeout(boot, 60);
  } else {
    boot();
  }
})();
