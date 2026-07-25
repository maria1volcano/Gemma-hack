/*
 * KidGuard mascot - controller: lifecycle, public API, overlay positioning,
 * speech bubble, minimise control, mood orchestration.
 *
 * POSITIONING OWNERSHIP (important, read before changing anything)
 * ---------------------------------------------------------------
 * content.js (Person B) already applies `transform: translate(x, y)` to
 * #kidguard-mascot-host on every decision. We must never fight that, so:
 *
 *   - content.js stays the single owner of the mascot's BASE position.
 *   - we own a bounded LOCAL offset applied to our own wrapper *inside* the
 *     host, plus orientation / lean / pointing inside the 3D scene.
 *
 * The two compose instead of fighting: host transform x our wrapper transform.
 * The offset is clamped so the mascot always stays in the viewport and never
 * covers the highlighted element. Nothing here writes to host.style.transform.
 */
(function () {
  "use strict";

  var NS = (window.KidGuardMascotNS = window.KidGuardMascotNS || {});
  if (NS.controllerLoaded) return;
  NS.controllerLoaded = true;

  // Slightly landscape: a capybara is a wide, low animal and a portrait canvas
  // would waste most of its height (verified with the headless framing check).
  var CANVAS_W = 172;
  var CANVAS_H = 158;
  var HALF_W = CANVAS_W / 2;
  var HALF_H = CANVAS_H / 2;
  var MSG_MS = 5200;
  var POINT_RETURN_MS = 6000;
  var HAPPY_RETURN_MS = 3200;
  var EDGE = 8;

  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
  }

  NS.url = function (path) {
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) {
        return chrome.runtime.getURL(path);
      }
    } catch (e) {}
    return path; // preview harness: plain relative path
  };

  function findHost() {
    var K = window.__KIDGUARD__;
    if (K && typeof K.getMascotHost === "function") {
      try {
        var h = K.getMascotHost();
        if (h) return h;
      } catch (e) {}
    }
    var direct = document.getElementById("kidguard-mascot-host");
    if (direct) return direct;
    var root = document.getElementById("kidguard-root");
    if (root && root.shadowRoot) return root.shadowRoot.getElementById("kidguard-mascot-host");
    return null;
  }

  function normaliseRect(r) {
    if (!r) return null;
    var top = typeof r.top === "number" ? r.top : typeof r.y === "number" ? r.y : null;
    var left = typeof r.left === "number" ? r.left : typeof r.x === "number" ? r.x : null;
    var w = typeof r.width === "number" ? r.width : 0;
    var h = typeof r.height === "number" ? r.height : 0;
    if (top === null || left === null) return null;
    if (!isFinite(top) || !isFinite(left)) return null;
    return { top: top, left: left, width: Math.max(0, w), height: Math.max(0, h) };
  }
  NS.normaliseRect = normaliseRect;

  function rectsOverlap(a, b) {
    return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
  }

  /* ------------------------------------------------------------ controller */

  NS.createController = function () {
    var host = findHost();
    if (!host) return null;

    var reducedQuery = null;
    var reduced = false;
    try {
      reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
      reduced = !!(reducedQuery && reducedQuery.matches);
    } catch (e) {}

    /* ---------------------------------------------------------------- DOM */

    var rootNode = host.getRootNode ? host.getRootNode() : document;
    var cssParent = rootNode && rootNode.host ? rootNode : document.head || document.documentElement;
    if (cssParent && !cssParent.querySelector('link[data-kgm-css="1"]')) {
      var link = document.createElement("link");
      link.rel = "stylesheet";
      link.setAttribute("data-kgm-css", "1");
      link.href = NS.url("mascot/mascot.css");
      cssParent.appendChild(link);
    }

    // Our canvas lives inside the host so content.js keeps owning the position.
    var stage = document.createElement("div");
    stage.className = "kgm-stage";
    stage.style.width = CANVAS_W + "px";
    stage.style.height = CANVAS_H + "px";
    host.appendChild(stage);

    // Bubble + controls sit in a sibling full-viewport layer so they are never
    // dragged around by the host transform.
    var layer = document.createElement("div");
    layer.className = "kgm-layer";
    (host.parentNode || host).appendChild(layer);

    var bubble = document.createElement("div");
    bubble.className = "kgm-bubble";
    bubble.setAttribute("role", "status");
    bubble.setAttribute("aria-live", "polite");
    var bubbleText = document.createElement("span");
    bubbleText.className = "kgm-bubble-text";
    bubble.appendChild(bubbleText);
    var bubbleClose = document.createElement("button");
    bubbleClose.type = "button";
    bubbleClose.className = "kgm-bubble-close";
    bubbleClose.setAttribute("aria-label", "Close message");
    bubbleClose.textContent = "\u00d7";
    bubble.appendChild(bubbleClose);
    layer.appendChild(bubble);

    var toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "kgm-toggle";
    toggle.setAttribute("aria-label", "Hide the KidGuard buddy");
    toggle.title = "Hide the KidGuard buddy";
    toggle.textContent = "\u2013";
    layer.appendChild(toggle);

    /* -------------------------------------------------------------- scene */

    var state = {
      mood: "idle",
      minimised: false,
      hidden: false,
      offX: 0,
      offY: 0,
      target: null, // normalised rect in viewport coords
      destroyed: false,
      ready: false,
      lastError: ""
    };

    var listeners = [];
    var timers = { msg: 0, mood: 0 };
    var statusCbs = [];

    function emitStatus() {
      for (var i = 0; i < statusCbs.length; i++) {
        try {
          statusCbs[i]({
            mood: state.mood,
            minimised: state.minimised,
            hidden: state.hidden,
            ready: state.ready,
            usingGlb: scene ? scene.usingGlb : false,
            error: state.lastError
          });
        } catch (e) {}
      }
    }

    var scene = NS.createScene({
      width: CANVAS_W,
      height: CANVAS_H,
      reduced: reduced,
      glbUrl: NS.url("assets/mascot.glb"),
      onFirstFrame: function () {
        state.ready = true;
        // Only now is the 3D actually on screen: drop the CSS placeholder.
        try {
          var K = window.__KIDGUARD__;
          if (K && typeof K.setMascotRendererReady === "function") K.setMascotRendererReady();
        } catch (e) {}
        emitStatus();
      },
      onStatus: function (text) {
        state.lastError = /fail|unusable|unavailable|not found/i.test(text) ? text : "";
        NS.lastSceneStatus = text;
        emitStatus();
      },
      onError: function (text) {
        state.lastError = text || "scene error";
        emitStatus();
      }
    });

    if (!scene) {
      // No WebGL: leave Person B's CSS placeholder in place and clean up.
      stage.remove();
      layer.remove();
      return null;
    }
    scene.mount(stage);

    /* ------------------------------------------------- throttled geometry */

    var rafPending = 0;
    function schedule() {
      if (state.destroyed || rafPending) return;
      rafPending = requestAnimationFrame(function () {
        rafPending = 0;
        applyLayout();
      });
    }

    function baseCentre() {
      // One layout read per frame at most; the host is the position anchor.
      var r = host.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }

    function computeOffset(base) {
      if (!state.target) return { x: 0, y: 0 };
      var vw = window.innerWidth;
      var vh = window.innerHeight;
      var t = state.target;
      var tcx = t.left + t.width / 2;
      var tcy = t.top + t.height / 2;
      var dx = tcx - base.x;
      var dy = tcy - base.y;

      // Drift toward the relevant side of the viewport, but only a little: the
      // base position belongs to content.js.
      var ox = clamp(dx * 0.28, -130, 130);
      var oy = clamp(dy * 0.18, -80, 80);

      // Never cover the highlighted element.
      var pad = 18;
      var tgt = {
        left: t.left - pad,
        top: t.top - pad,
        right: t.left + t.width + pad,
        bottom: t.top + t.height + pad
      };
      var box = {
        left: base.x + ox - HALF_W,
        top: base.y + oy - HALF_H,
        right: base.x + ox + HALF_W,
        bottom: base.y + oy + HALF_H
      };
      if (rectsOverlap(box, tgt)) {
        var leftSlot = tgt.left - HALF_W - 6 - base.x; // mascot fully left of target
        var rightSlot = tgt.right + HALF_W + 6 - base.x; // fully right of target
        var canLeft = base.x + leftSlot - HALF_W >= EDGE;
        var canRight = base.x + rightSlot + HALF_W <= vw - EDGE;
        if (canRight && (!canLeft || Math.abs(rightSlot) <= Math.abs(leftSlot))) ox = rightSlot;
        else if (canLeft) ox = leftSlot;
        else oy = tgt.bottom + HALF_H + 6 - base.y; // no room sideways: go below
      }

      ox = clamp(ox, EDGE + HALF_W - base.x, vw - EDGE - HALF_W - base.x);
      oy = clamp(oy, EDGE + HALF_H - base.y, vh - EDGE - HALF_H - base.y);
      if (!isFinite(ox)) ox = 0;
      if (!isFinite(oy)) oy = 0;
      return { x: ox, y: oy };
    }

    function applyLayout() {
      if (state.destroyed) return;
      var base = baseCentre();
      var off = state.minimised || state.hidden ? { x: 0, y: 0 } : computeOffset(base);
      state.offX = off.x;
      state.offY = off.y;
      stage.style.transform = "translate(-50%,-50%) translate(" + off.x + "px," + off.y + "px)";

      var cx = base.x + off.x;
      var cy = base.y + off.y;

      // Pointing direction is computed from where the mascot actually is.
      if (state.mood === "point" && state.target) {
        var tcx = state.target.left + state.target.width / 2;
        var tcy = state.target.top + state.target.height / 2;
        scene.setPoint(clamp((tcx - cx) / 320, -1, 1), clamp((tcy - cy) / 320, -1, 1));
      } else {
        scene.setPoint(null);
      }

      layoutBubble(cx, cy);
      layoutToggle(cx, cy);
    }

    function layoutToggle(cx, cy) {
      var vw = window.innerWidth;
      var vh = window.innerHeight;
      var x = clamp(cx + HALF_W - 30, EDGE, vw - 34);
      var y = clamp(cy - HALF_H + 6, EDGE, vh - 34);
      toggle.style.transform = "translate(" + Math.round(x) + "px," + Math.round(y) + "px)";
    }

    function layoutBubble(cx, cy) {
      if (!bubble.classList.contains("kgm-on")) return;
      var vw = window.innerWidth;
      var vh = window.innerHeight;
      var bw = bubble.offsetWidth || 200;
      var bh = bubble.offsetHeight || 56;

      var x = clamp(cx - bw / 2, EDGE, Math.max(EDGE, vw - bw - EDGE));
      var above = cy - HALF_H - bh - 10;
      var below = cy + HALF_H + 10;
      var y = above >= EDGE ? above : below;

      // Keep the bubble off the highlighted element too.
      if (state.target) {
        var t = state.target;
        var tgt = { left: t.left - 6, top: t.top - 6, right: t.left + t.width + 6, bottom: t.top + t.height + 6 };
        var box = { left: x, top: y, right: x + bw, bottom: y + bh };
        if (rectsOverlap(box, tgt)) {
          var alt = y === above ? below : above;
          var altBox = { left: x, top: alt, right: x + bw, bottom: alt + bh };
          if (alt >= EDGE && alt + bh <= vh - EDGE && !rectsOverlap(altBox, tgt)) y = alt;
          else if (tgt.left > bw + EDGE * 2) x = clamp(tgt.left - bw - 8, EDGE, vw - bw - EDGE);
          else x = clamp(tgt.right + 8, EDGE, Math.max(EDGE, vw - bw - EDGE));
        }
      }
      y = clamp(y, EDGE, Math.max(EDGE, vh - bh - EDGE));
      bubble.classList.toggle("kgm-below", y > cy);
      bubble.style.transform = "translate(" + Math.round(x) + "px," + Math.round(y) + "px)";
    }

    /* ------------------------------------------------------------- moods */

    function clearMoodTimer() {
      if (timers.mood) clearTimeout(timers.mood);
      timers.mood = 0;
    }

    function setMood(mood, opts) {
      if (state.destroyed) return;
      var m = mood === "worry" || mood === "happy" || mood === "point" ? mood : "idle";
      opts = opts || {};
      clearMoodTimer();
      state.mood = m;
      if (m !== "point") state.target = opts.keepTarget ? state.target : null;
      scene.setMood(m);
      if (m === "point") {
        timers.mood = setTimeout(function () {
          setMood("idle");
        }, typeof opts.returnAfter === "number" ? opts.returnAfter : POINT_RETURN_MS);
      } else if (m === "happy") {
        timers.mood = setTimeout(function () {
          setMood("idle");
        }, typeof opts.returnAfter === "number" ? opts.returnAfter : HAPPY_RETURN_MS);
      }
      schedule();
      emitStatus();
    }

    function setMessage(text, ms) {
      if (state.destroyed) return;
      if (timers.msg) clearTimeout(timers.msg);
      timers.msg = 0;
      var str = text === null || text === undefined ? "" : String(text).slice(0, 220).trim();
      if (!str || state.hidden || state.minimised) {
        hideBubble();
        return;
      }
      bubbleText.textContent = str;
      bubble.classList.add("kgm-on");
      // One forced layout read here (not per frame) so the bubble can be placed,
      // then a few cheap re-reads in case mascot.css had not landed yet.
      applyLayout();
      settle();
      var life = typeof ms === "number" ? ms : MSG_MS;
      if (life > 0) {
        timers.msg = setTimeout(hideBubble, life);
      }
    }

    function hideBubble() {
      if (timers.msg) clearTimeout(timers.msg);
      timers.msg = 0;
      bubble.classList.remove("kgm-on");
    }

    function pointToRect(rect, opts) {
      var r = normaliseRect(rect);
      opts = opts || {};
      if (!r) {
        // Target missing / unresolvable: stay useful, just look concerned.
        setMood(opts.fallbackMood || "idle");
        if (opts.message) setMessage(opts.message);
        return false;
      }
      // Off-screen targets are kept as-is: the mascot then points in their
      // direction instead of disappearing with them.
      state.target = r;
      setMood("point", { keepTarget: true, returnAfter: opts.returnAfter });
      state.target = r;
      if (opts.message) setMessage(opts.message);
      schedule();
      applyLayout();
      return true;
    }

    /* --------------------------------------------------------- listeners */

    function on(target, type, fn, opts) {
      target.addEventListener(type, fn, opts || false);
      listeners.push([target, type, fn, opts || false]);
    }

    var onScrollResize = function () {
      schedule();
    };
    on(window, "scroll", onScrollResize, { passive: true, capture: true });
    on(window, "resize", onScrollResize, { passive: true });

    on(bubbleClose, "click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      hideBubble();
    });

    on(toggle, "click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      api.setMinimised(!state.minimised);
    });

    if (reducedQuery) {
      var onReducedChange = function (e) {
        reduced = !!e.matches;
        scene.setReduced(reduced);
        stage.classList.toggle("kgm-reduced", reduced);
        schedule();
      };
      if (reducedQuery.addEventListener) on(reducedQuery, "change", onReducedChange);
      else if (reducedQuery.addListener) reducedQuery.addListener(onReducedChange);
    }
    stage.classList.toggle("kgm-reduced", reduced);

    // Keep up with content.js moving the host around (its transform has a
    // 420 ms CSS transition, so re-read for a moment afterwards).
    var settleTimer = 0;
    function settle() {
      if (settleTimer) clearInterval(settleTimer);
      var until = Date.now() + 700;
      settleTimer = setInterval(function () {
        schedule();
        if (Date.now() > until) {
          clearInterval(settleTimer);
          settleTimer = 0;
        }
      }, 90);
    }

    /* ------------------------------------------------------------- public */

    var api = {
      show: function () {
        state.hidden = false;
        state.minimised = false;
        stage.style.display = "";
        toggle.textContent = "\u2013";
        toggle.setAttribute("aria-label", "Hide the KidGuard buddy");
        layer.classList.remove("kgm-layer-off");
        scene.setVisible(true);
        schedule();
        emitStatus();
        return api;
      },
      hide: function () {
        state.hidden = true;
        hideBubble();
        stage.style.display = "none";
        scene.setVisible(false);
        layer.classList.add("kgm-layer-off");
        emitStatus();
        return api;
      },
      setMinimised: function (v) {
        state.minimised = !!v;
        if (state.minimised) {
          hideBubble();
          stage.style.display = "none";
          scene.setVisible(false);
          toggle.textContent = "\u25cf";
          toggle.setAttribute("aria-label", "Show the KidGuard buddy");
          toggle.title = "Show the KidGuard buddy";
        } else {
          state.hidden = false;
          stage.style.display = "";
          scene.setVisible(true);
          toggle.textContent = "\u2013";
          toggle.setAttribute("aria-label", "Hide the KidGuard buddy");
          toggle.title = "Hide the KidGuard buddy";
        }
        schedule();
        emitStatus();
        return api;
      },
      setMood: function (mood) {
        setMood(mood);
        settle();
        return api;
      },
      getMood: function () {
        return state.mood;
      },
      setMessage: function (text, ms) {
        setMessage(text, ms);
        return api;
      },
      pointToElement: function (el, opts) {
        if (!el || typeof el.getBoundingClientRect !== "function") {
          return pointToRect(null, opts);
        }
        return pointToRect(el.getBoundingClientRect(), opts);
      },
      pointToCoordinates: function (x, y, opts) {
        if (typeof x !== "number" || typeof y !== "number" || !isFinite(x) || !isFinite(y)) {
          return pointToRect(null, opts);
        }
        return pointToRect({ left: x - 1, top: y - 1, width: 2, height: 2 }, opts);
      },
      pointToRect: pointToRect,
      // Remember a rect the mascot and its bubble must not cover, without
      // switching to the pointing pose (used for warn/block + highlight).
      setAvoidRect: function (rect) {
        state.target = normaliseRect(rect);
        schedule();
        return api;
      },
      reset: function () {
        clearMoodTimer();
        hideBubble();
        state.target = null;
        api.show();
        setMood("idle");
        return api;
      },
      destroy: function () {
        if (state.destroyed) return;
        state.destroyed = true;
        clearMoodTimer();
        if (timers.msg) clearTimeout(timers.msg);
        if (settleTimer) clearInterval(settleTimer);
        if (rafPending) cancelAnimationFrame(rafPending);
        for (var i = 0; i < listeners.length; i++) {
          try {
            listeners[i][0].removeEventListener(listeners[i][1], listeners[i][2], listeners[i][3]);
          } catch (e) {}
        }
        listeners.length = 0;
        if (NS.detachEvents) {
          try {
            NS.detachEvents();
          } catch (e) {}
        }
        try {
          scene.dispose();
        } catch (e) {}
        if (stage.parentNode) stage.parentNode.removeChild(stage);
        if (layer.parentNode) layer.parentNode.removeChild(layer);
        NS.controller = null;
        emitStatus();
      },
      onStatus: function (cb) {
        if (typeof cb === "function") statusCbs.push(cb);
        emitStatus();
        return api;
      },
      get state() {
        return {
          mood: state.mood,
          minimised: state.minimised,
          hidden: state.hidden,
          ready: state.ready,
          usingGlb: scene.usingGlb,
          procedural: scene.isProcedural,
          error: state.lastError,
          target: state.target
        };
      },
      _settle: settle
    };

    NS.controller = api;
    applyLayout();
    settle();
    return api;
  };
})();
