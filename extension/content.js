/*
 * KidGuard content script.
 *
 * 1. Scrapes the page and asks the service worker for a decision.
 * 2. Executes the tool calls Gemma returned.
 *
 * FROZEN TOOL CONTRACT (do not rename):
 *   allow_page()
 *   warn_kid(message, reason)
 *   block_page(reason, safer_alternative)
 *   pause_session(reason)
 *   highlight_element(text_or_css, message)
 *   move_mascot(x_hint, mood)            mood in idle|worry|happy|point
 *   notify_parent(summary)
 *   suggest_alternative(label, url)
 *   navigate_hint(url)
 *
 * pause_session is session-wide, not page-wide: the paused flag lives in
 * chrome.storage.local (kidguard_paused / kidguard_pause_reason, the very keys
 * background.js and the side panel already share), so the calm break screen is
 * repainted on every page the kid opens until a grown-up resumes from the side
 * panel. While paused no new decision is requested.
 *
 * MASCOT SEAM FOR TEAMMATE C
 * --------------------------
 * Every move_mascot / highlight_element dispatches on the page document:
 *
 *   document.addEventListener('kidguard:mascot', (e) => {
 *     // e.detail = { mood, x, y, targetRect }
 *     //   mood       : 'idle' | 'worry' | 'happy' | 'point'
 *     //   x, y       : viewport pixel coords the mascot should move to
 *     //   targetRect : {top,left,width,height} of the highlighted element, or null
 *   });
 *
 * Mount point: the element with id "kidguard-mascot-host" inside the shadow
 * root of #kidguard-root. Get it with window.__KIDGUARD__.getMascotHost().
 * Replace its children with a Three.js canvas; the placeholder blob removes
 * itself as soon as C calls setMascotRendererReady().
 *
 * Also available (same isolated world, i.e. another content script of this
 * extension):
 *   window.__KIDGUARD__ = {
 *     onMascot(cb),            // subscribe, returns an unsubscribe function
 *     getHighlightRect(),      // last highlighted rect or null
 *     getMascotHost(),         // the <div id="kidguard-mascot-host">
 *     setMascotRendererReady() // hides the placeholder blob
 *   }
 */

(() => {
  if (window.__KIDGUARD_LOADED__) return;
  window.__KIDGUARD_LOADED__ = true;

  const ROOT_ID = "kidguard-root";
  const MAX_TEXT = 1500;

  // Same keys background.js writes and the side panel reads. Duplicated here on
  // purpose: a content script cannot import from the service worker.
  const PAUSE_KEYS = { paused: "kidguard_paused", reason: "kidguard_pause_reason" };
  const DEFAULT_PAUSE_REASON = "We have seen a few tricky pages, so it is a good moment to stop.";

  let shadow = null;
  let layers = null; // {warn, block, pause, ring, tooltip, chips, toast, hint, mascotHost}
  let sessionPaused = false;
  let pauseReason = "";
  let highlightState = null; // {el, rect, raf, ...}
  let highlightRetry = null; // {timer} while we wait for a late-rendered target
  let mascotSubscribers = [];
  let mascotRendererReady = false;

  /* ------------------------------------------------------------ shadow root */

  function ensureRoot() {
    const existing = document.querySelectorAll("#" + ROOT_ID);
    if (shadow && existing.length === 1) return shadow;

    // A second injection (or a page that wiped our node) can leave orphan
    // containers behind. Drop every one of them so overlays never stack.
    for (const node of existing) node.remove();
    shadow = null;
    layers = null;

    const host = document.createElement("div");
    host.id = ROOT_ID;
    // Inline so the container survives even if overlay.css fails to load.
    host.style.cssText =
      "position:fixed;top:0;left:0;width:0;height:0;margin:0;padding:0;border:0;z-index:2147483000;pointer-events:none;";
    (document.documentElement || document.body).appendChild(host);

    shadow = host.attachShadow({ mode: "open" });

    try {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = chrome.runtime.getURL("overlay.css");
      shadow.appendChild(link);
    } catch (_) {
      /* extension context invalidated mid-reload — overlays still work via content_scripts css */
    }

    const stage = document.createElement("div");
    stage.className = "kg-stage";
    shadow.appendChild(stage);

    const mk = (cls, tag) => {
      const el = document.createElement(tag || "div");
      el.className = cls;
      stage.appendChild(el);
      return el;
    };

    layers = {
      stage: stage,
      warn: mk("kg-warn-slot"),
      block: mk("kg-block-slot"),
      pause: mk("kg-pause-slot"),
      ring: mk("kg-ring-slot"),
      chips: mk("kg-chip-slot"),
      toast: mk("kg-toast-slot"),
      hint: mk("kg-hint-slot"),
      mascotHost: mk("kg-mascot-host")
    };
    layers.mascotHost.id = "kidguard-mascot-host";
    layers.mascotHost.appendChild(buildPlaceholderMascot());

    // A page that wiped our container must not also wipe the break screen.
    if (sessionPaused) renderPaused(pauseReason);

    return shadow;
  }

  function buildPlaceholderMascot() {
    const wrap = document.createElement("div");
    wrap.className = "kg-mascot kg-mood-idle";
    wrap.setAttribute("data-kidguard-placeholder", "true");
    wrap.innerHTML =
      '<div class="kg-mascot-body">' +
      '<div class="kg-mascot-eye kg-eye-l"></div>' +
      '<div class="kg-mascot-eye kg-eye-r"></div>' +
      '<div class="kg-mascot-mouth"></div>' +
      "</div>";
    return wrap;
  }

  /* ------------------------------------------------------------ mascot seam */

  function emitMascot(mood, x, y, targetRect) {
    const detail = {
      mood: mood || "idle",
      x: Math.round(x),
      y: Math.round(y),
      targetRect: targetRect
        ? {
            top: Math.round(targetRect.top),
            left: Math.round(targetRect.left),
            width: Math.round(targetRect.width),
            height: Math.round(targetRect.height)
          }
        : null
    };

    // Placeholder reacts unless teammate C's renderer has taken over.
    const el = layers && layers.mascotHost;
    if (el) {
      el.style.transform = "translate(" + detail.x + "px," + detail.y + "px)";
      const blob = el.querySelector(".kg-mascot");
      if (blob && !mascotRendererReady) {
        blob.className = "kg-mascot kg-mood-" + detail.mood;
      }
    }

    try {
      document.dispatchEvent(new CustomEvent("kidguard:mascot", { detail: detail }));
    } catch (_) {
      /* page may block CustomEvent construction; never fatal */
    }
    mascotSubscribers.forEach((cb) => {
      try {
        cb(detail);
      } catch (_) {}
    });
  }

  function defaultMascotSpot() {
    return { x: Math.max(16, window.innerWidth - 140), y: Math.max(16, window.innerHeight - 160) };
  }

  /* ------------------------------------------------------------------ tools */

  function clearWarn() {
    if (layers) layers.warn.textContent = "";
  }

  function clearBlock() {
    if (layers) {
      layers.block.textContent = "";
      layers.stage.classList.remove("kg-blocking");
    }
  }

  /* ---------------------------------------------------------- paused session */

  // Deliberately no "unpause" button: this screen is kid-facing. The grown-up
  // resumes from the side panel ("Parent: resume session").
  function renderPaused(reason) {
    if (!layers) return;
    layers.pause.textContent = "";

    const box = document.createElement("div");
    box.className = "kg-pause";
    box.innerHTML =
      '<div class="kg-pause-card">' +
      '<div class="kg-pause-moon"></div>' +
      '<h1 class="kg-pause-title">Let\'s take a break</h1>' +
      '<p class="kg-pause-lead">I put the internet on pause for a little while. You did nothing wrong.</p>' +
      '<p class="kg-pause-reason"></p>' +
      '<p class="kg-pause-foot">Your grown-up can unpause this from the KidGuard buddy panel.</p>' +
      "</div>";
    box.querySelector(".kg-pause-reason").textContent = reason || DEFAULT_PAUSE_REASON;

    layers.pause.appendChild(box);
    layers.stage.classList.add("kg-paused");
  }

  function applyPaused(reason) {
    sessionPaused = true;
    pauseReason = String(reason || "").trim();
    ensureRoot();
    cancelHighlightRetry();
    clearHighlight();
    clearChips();
    clearWarn();
    clearBlock();
    if (layers) layers.hint.textContent = "";
    renderPaused(pauseReason);
    const spot = { x: Math.round(window.innerWidth / 2) - 60, y: Math.round(window.innerHeight / 2) + 150 };
    emitMascot("worry", spot.x, spot.y, null);
  }

  function clearPaused() {
    sessionPaused = false;
    pauseReason = "";
    if (layers) {
      layers.pause.textContent = "";
      layers.stage.classList.remove("kg-paused");
    }
  }

  function readPausedState() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([PAUSE_KEYS.paused, PAUSE_KEYS.reason], (raw) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(raw || {});
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  function cancelHighlightRetry() {
    if (highlightRetry && highlightRetry.timer) clearTimeout(highlightRetry.timer);
    highlightRetry = null;
  }

  function clearHighlight() {
    const st = highlightState;
    highlightState = null;
    if (st) {
      if (st.raf) cancelAnimationFrame(st.raf);
      if (st.settle) cancelAnimationFrame(st.settle);
      if (st.request) {
        window.removeEventListener("scroll", st.request, true);
        window.removeEventListener("resize", st.request);
      }
      if (st.observer) {
        try {
          st.observer.disconnect();
        } catch (_) {}
      }
    }
    if (layers) layers.ring.textContent = "";
  }

  function clearChips() {
    if (layers) layers.chips.textContent = "";
  }

  function clearToasts() {
    if (layers) layers.toast.textContent = "";
  }

  let thinkingTimer = 0;
  let thinkingEl = null;

  function clearThinking() {
    clearTimeout(thinkingTimer);
    thinkingTimer = 0;
    if (thinkingEl && thinkingEl.parentNode) thinkingEl.remove();
    thinkingEl = null;
  }

  function toast(text, ms) {
    ensureRoot();
    const life = typeof ms === "number" ? ms : 2600;
    const el = document.createElement("div");
    el.className = "kg-toast";
    el.textContent = text;
    layers.toast.appendChild(el);
    setTimeout(() => {
      if (el.parentNode) el.classList.add("kg-toast-out");
    }, life);
    setTimeout(() => {
      if (el.parentNode) el.remove();
    }, life + 600);
    return el;
  }

  // Shown when the side panel refuses to open without a live user gesture.
  function showPanelHint() {
    ensureRoot();
    layers.hint.textContent = "";
    const box = document.createElement("div");
    box.className = "kg-hint";
    box.innerHTML =
      '<div class="kg-hint-arrow">&#8599;</div>' +
      '<div class="kg-hint-text">Click the <b>KidGuard</b> icon up here to open your buddy.</div>' +
      '<button class="kg-hint-close" type="button">Got it</button>';
    box.querySelector(".kg-hint-close").addEventListener("click", () => box.remove());
    layers.hint.appendChild(box);
    setTimeout(() => box.remove(), 12000);
  }

  const TOOLS = {
    allow_page() {
      ensureRoot();
      clearWarn();
      clearBlock();
      const spot = defaultMascotSpot();
      emitMascot("happy", spot.x, spot.y, null);
    },

    warn_kid(args) {
      ensureRoot();
      // A full block already carries the message — don't stack a second card.
      if (layers.stage.classList.contains("kg-blocking")) return;
      clearWarn();
      const message = args.message || "Careful with this page.";
      const reason = args.reason || "";

      const box = document.createElement("div");
      box.className = "kg-warn";
      box.innerHTML =
        '<div class="kg-warn-face">!</div>' +
        '<div class="kg-warn-body">' +
        '<div class="kg-warn-title"></div>' +
        '<div class="kg-warn-reason"></div>' +
        "</div>" +
        '<button class="kg-warn-close" type="button" aria-label="Close">x</button>';
      box.querySelector(".kg-warn-title").textContent = message;
      box.querySelector(".kg-warn-reason").textContent = reason;
      box.querySelector(".kg-warn-close").addEventListener("click", clearWarn);
      layers.warn.appendChild(box);
      const spot = { x: 28, y: Math.max(16, window.innerHeight - 150) };
      emitMascot("worry", spot.x, spot.y, null);
    },

    block_page(args) {
      ensureRoot();
      clearWarn();
      clearBlock();
      const reason = args.reason || "This page is not safe for you.";
      const saferRaw = args.safer_alternative || "";
      const safer = /^https?:\/\//i.test(saferRaw)
        ? saferRaw
        : "http://127.0.0.1:8765/demo_sites/classroom.html";

      const box = document.createElement("div");
      box.className = "kg-block";
      box.innerHTML =
        '<div class="kg-block-card">' +
        '<div class="kg-block-head">' +
        '<div class="kg-block-face">:(</div>' +
        '<h1 class="kg-block-title">Let\'s not go here</h1>' +
        "</div>" +
        '<p class="kg-block-reason"></p>' +
        '<div class="kg-block-actions">' +
        '<button class="kg-btn kg-btn-primary" type="button" data-kg="safe">Take me somewhere safe</button>' +
        '<button class="kg-btn kg-btn-ghost" type="button" data-kg="buddy">Ask my buddy</button>' +
        "</div>" +
        "</div>";
      box.querySelector(".kg-block-reason").textContent = reason;

      box.querySelector('[data-kg="safe"]').addEventListener("click", () => goTo(safer));
      box.querySelector('[data-kg="buddy"]').addEventListener("click", () => {
        send({ type: "KG_OPEN_PANEL" }).then((res) => {
          if (!res || !res.ok) showPanelHint();
        });
      });

      layers.block.appendChild(box);
      // Coach mode: keep the page visible (no blur). Mascot sits under the card.
      layers.stage.classList.add("kg-blocking");
      const spot = { x: 28, y: Math.max(16, window.innerHeight - 150) };
      emitMascot("worry", spot.x, spot.y, null);
    },

    // Session-wide, unlike block_page which is about this one page.
    pause_session(args) {
      const reason = String(args.reason || "").trim();
      applyPaused(reason);
      send({ type: "KG_SET_SETTINGS", payload: { paused: true, pause_reason: reason } });
      send({
        type: "KG_NOTIFY_PARENT",
        payload: {
          summary: "Session paused. " + (reason || DEFAULT_PAUSE_REASON),
          url: location.href
        }
      });
    },

    highlight_element(args) {
      ensureRoot();
      const query = args.text_or_css || args.selector || args.text || "";
      const message = args.message || "Look here.";
      const safe = args.safe === true || args.style === "safe" || /safer|safe|classroom|resource/i.test(message);
      cancelHighlightRetry();
      attemptHighlight(String(query || ""), message, 0, safe);
    },

    move_mascot(args) {
      ensureRoot();
      const mood = ["idle", "worry", "happy", "point"].includes(args.mood) ? args.mood : "idle";
      const spot = resolveXHint(args.x_hint);
      emitMascot(mood, spot.x, spot.y, highlightState ? highlightState.rect : null);
    },

    notify_parent(args) {
      const summary = args.summary || "";
      send({ type: "KG_NOTIFY_PARENT", payload: { summary: summary, url: location.href } });
      // Quiet during an on-page coach card — parent feed still gets the event.
      if (!layers || layers.stage.classList.contains("kg-blocking")) return;
      toast("I told your grown-up.");
    },

    suggest_alternative(args) {
      ensureRoot();
      const label = args.label || "Somewhere safer";
      const url = args.url || "";
      if (!url) return;
      addChip("kg-chip-safe", label, url);
    },

    navigate_hint(args) {
      ensureRoot();
      const url = args.url || "";
      if (!url) return;
      addChip("kg-chip-go", "Go here: " + shortUrl(url), url);
    }
  };

  function addChip(cls, label, url) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "kg-chip " + cls;
    chip.textContent = label;
    chip.addEventListener("click", () => goTo(url));
    layers.chips.appendChild(chip);
  }

  function shortUrl(url) {
    try {
      const u = new URL(url, location.href);
      return (u.pathname.split("/").pop() || u.hostname) || url;
    } catch (_) {
      return url;
    }
  }

  function goTo(url) {
    let abs = url;
    try {
      abs = new URL(url, location.href).href;
    } catch (_) {}
    send({ type: "KG_NAVIGATE", payload: { url: abs } }).then((res) => {
      if (!res || !res.ok) location.href = abs;
    });
  }

  function resolveXHint(hint) {
    const fallback = defaultMascotSpot();
    if (typeof hint === "number" && isFinite(hint)) return { x: clampX(hint), y: fallback.y };
    const h = String(hint || "").toLowerCase();
    if (h === "left") return { x: 24, y: fallback.y };
    if (h === "center" || h === "centre") return { x: Math.round(window.innerWidth / 2) - 60, y: fallback.y };
    if (h === "right") return fallback;
    if (h === "target" && highlightState && highlightState.rect) {
      const r = highlightState.rect;
      return { x: clampX(r.left + r.width + 16), y: Math.max(16, r.top - 20) };
    }
    const num = parseFloat(h);
    if (!isNaN(num)) return { x: clampX(num), y: fallback.y };
    return fallback;
  }

  function clampX(x) {
    return Math.max(8, Math.min(x, window.innerWidth - 120));
  }

  /* ------------------------------------------------------- target resolution */

  const INTERACTIVE =
    'button, a, input, textarea, select, label, summary, [role="button"], [role="link"], [tabindex]';
  const TEXT_BLOCKS = "h1, h2, h3, h4, p, li, td, th, legend, figcaption, strong, span, div";
  const TEXT_BLOCK_LIMIT = 600;

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
  }

  // document.querySelectorAll throws on anything that is not a selector, and a
  // model happily returns "the password box" here. Never let that bubble up.
  function safeQueryAll(selector) {
    try {
      return Array.prototype.slice.call(document.querySelectorAll(selector));
    } catch (_) {
      return [];
    }
  }

  function pickVisible(list) {
    for (const el of list) if (isVisible(el)) return el;
    return list.length ? list[0] : null;
  }

  function norm(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  // A <label> is rarely what we want to ring: point at the field it labels.
  function labelTarget(el) {
    if (el && el.tagName === "LABEL") {
      const forId = el.getAttribute("for");
      const ctrl = (forId && document.getElementById(forId)) || el.querySelector("input, textarea, select");
      if (ctrl) return ctrl;
    }
    return el;
  }

  function attrHay(el) {
    return [
      el.getAttribute("aria-label"),
      el.getAttribute("placeholder"),
      el.getAttribute("name"),
      el.getAttribute("value"),
      el.getAttribute("title"),
      el.getAttribute("alt"),
      el.id
    ]
      .filter(Boolean)
      .map(norm);
  }

  // Short recipe tokens → longer page phrases (ok_school / classroom demos).
  const HIGHLIGHT_ALIASES = {
    tips: ["Homework tips that actually help", "Homework tips", "Study Tips"],
    tip: ["Homework tips that actually help", "Homework tips"],
    "homework tips": ["Homework tips that actually help"],
    "study tips": ["Study Tips", "Homework tips that actually help"],
    "reading: three pages": ["2. Reading: Three Pages and a Question", "Reading: Three Pages and a Question"],
    "maths: fraction pizza": ["1. Maths: Fraction Pizza"],
    "science: cloud watch": ["3. Science: Cloud Watch"]
  };

  /*
   * Resolution chain, most precise first:
   *   1. valid CSS selector
   *   2. bare token treated as an id / name ("password" -> #password)
   *   3. exact visible-text match on an interactive element
   *   4. partial case-insensitive text match on an interactive element
   *   5. aria-label / placeholder / name / value / title / alt / id match
   *   6. exact / longest-partial text match on a plain text block
   *   7. synonym aliases for short demo tokens ("tips" → heading phrase)
   */
  function resolveTargetOnce(query) {
    const q = String(query || "").trim();
    if (!q) return null;

    const bySelector = pickVisible(safeQueryAll(q));
    if (bySelector) return labelTarget(bySelector);

    if (/^[A-Za-z_][\w-]*$/.test(q)) {
      const byToken = pickVisible(safeQueryAll("#" + q + ', [name="' + q + '"], [data-testid="' + q + '"]'));
      if (byToken) return labelTarget(byToken);
    }

    const needle = norm(q);
    if (!needle) return null;

    let partialText = null;
    let exactAttr = null;
    let partialAttr = null;

    for (const el of safeQueryAll(INTERACTIVE)) {
      if (!isVisible(el)) continue;
      const text = norm(el.innerText || el.textContent);
      if (text && text === needle) return labelTarget(el);
      if (!partialText && text && (text.includes(needle) || needle.includes(text)) && text.length > 1) {
        partialText = el;
      }
      if (!exactAttr || !partialAttr) {
        for (const hay of attrHay(el)) {
          if (hay === needle) {
            if (!exactAttr) exactAttr = el;
          } else if (!partialAttr && hay.includes(needle)) {
            partialAttr = el;
          }
        }
      }
    }

    if (partialText) return labelTarget(partialText);
    if (exactAttr) return labelTarget(exactAttr);
    if (partialAttr) return labelTarget(partialAttr);

    const blocks = safeQueryAll(TEXT_BLOCKS).slice(0, TEXT_BLOCK_LIMIT);
    let bestPartial = null;
    let bestPartialLen = Infinity;
    // Short tokens like "tips" need a word-boundary match; longer phrases use includes.
    let wordRe = null;
    if (needle.length >= 3 && needle.length < 6) {
      try {
        wordRe = new RegExp("(?:^|\\s)" + needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?:\\s|$|[.,:;!?])");
      } catch (_) {
        wordRe = null;
      }
    }
    for (const el of blocks) {
      if (!isVisible(el)) continue;
      const text = norm(el.textContent);
      if (!text) continue;
      if (text === needle) return el;
      // Prefer the tightest containing block so a section <div> does not win.
      const loose = needle.length >= 6 && text.includes(needle);
      const wordHit = wordRe && wordRe.test(text);
      if ((loose || wordHit) && text.length < bestPartialLen) {
        bestPartial = el;
        bestPartialLen = text.length;
      }
    }
    return bestPartial;
  }

  function resolveTarget(query) {
    const hit = resolveTargetOnce(query);
    if (hit) return hit;
    const aliases = HIGHLIGHT_ALIASES[norm(query)] || [];
    for (let i = 0; i < aliases.length; i++) {
      const alt = resolveTargetOnce(aliases[i]);
      if (alt) return alt;
    }
    return null;
  }

  /* --------------------------------------------------------------- tracking */

  // Retry a little: on a slow page the target may not be parsed yet when the
  // decision comes back. Then degrade to a visible message, never to nothing.
  const HIGHLIGHT_RETRY_MS = [200, 450, 900];

  function attemptHighlight(query, message, attempt, safe) {
    const el = resolveTarget(query);
    if (el) {
      cancelHighlightRetry();
      mountHighlight(el, message, !!safe);
      return;
    }
    if (attempt < HIGHLIGHT_RETRY_MS.length) {
      highlightRetry = {
        timer: setTimeout(() => attemptHighlight(query, message, attempt + 1, safe), HIGHLIGHT_RETRY_MS[attempt])
      };
      return;
    }
    cancelHighlightRetry();
    // Non-fatal: Chrome lists console.warn under the extension Errors button.
    if (typeof console !== "undefined" && console.debug) {
      console.debug("[KidGuard] highlight target not found:", query);
    }
    // The kid still gets the coaching sentence even without a ring.
    toast(message, 6000);
  }

  function mountHighlight(el, message, safe) {
    ensureRoot();
    clearHighlight();

    try {
      el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    } catch (_) {
      try {
        el.scrollIntoView();
      } catch (__) {}
    }

    const ring = document.createElement("div");
    ring.className = "kg-ring" + (safe ? " kg-ring-safe" : "");
    const tip = document.createElement("div");
    tip.className = "kg-tip" + (safe ? " kg-tip-safe" : "");
    tip.textContent = message;
    layers.ring.appendChild(ring);
    layers.ring.appendChild(tip);

    const st = {
      el: el,
      rect: null,
      raf: 0,
      settle: 0,
      settleUntil: Date.now() + 1600, // smooth scrollIntoView is still animating
      ring: ring,
      tip: tip,
      observer: null,
      request: null
    };
    highlightState = st;

    // rAF-throttled: scroll/resize only ask for a frame, layout is read once
    // per frame at most.
    st.request = function () {
      if (highlightState !== st || st.raf) return;
      st.raf = requestAnimationFrame(() => {
        st.raf = 0;
        positionHighlight(st);
      });
    };
    window.addEventListener("scroll", st.request, { passive: true, capture: true });
    window.addEventListener("resize", st.request, { passive: true });
    if (typeof ResizeObserver === "function") {
      try {
        st.observer = new ResizeObserver(st.request);
        st.observer.observe(el);
      } catch (_) {}
    }

    positionHighlight(st);
    settleHighlight(st);

    // After the coach card opens, walk the mascot over to the risky spot.
    if (st.rect) {
      const rx = clampX(st.rect.left + st.rect.width + 18);
      const ry = Math.max(16, Math.min(st.rect.top - 10, window.innerHeight - 140));
      emitMascot("point", rx, ry, st.rect);
    }
  }

  function settleHighlight(st) {
    if (highlightState !== st) return;
    positionHighlight(st);
    if (Date.now() < st.settleUntil) {
      st.settle = requestAnimationFrame(() => settleHighlight(st));
    } else {
      st.settle = 0;
    }
  }

  function positionHighlight(st) {
    if (highlightState !== st) return;
    if (!st.el || !document.contains(st.el)) {
      clearHighlight();
      return;
    }

    const r = st.el.getBoundingClientRect();
    st.rect = { top: r.top, left: r.left, width: r.width, height: r.height };

    const pad = 6;
    st.ring.style.transform = "translate(" + (r.left - pad) + "px," + (r.top - pad) + "px)";
    st.ring.style.width = r.width + pad * 2 + "px";
    st.ring.style.height = r.height + pad * 2 + "px";

    const below = r.bottom + 12;
    const tipTop = below + 60 > window.innerHeight ? Math.max(8, r.top - 56) : below;
    const tipLeft = Math.max(8, Math.min(r.left, window.innerWidth - 300));
    st.tip.style.transform = "translate(" + tipLeft + "px," + tipTop + "px)";
  }

  /* -------------------------------------------------------------- messaging */

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: "extension_context" });
            return;
          }
          resolve(res || { ok: false, error: "no_response" });
        });
      } catch (_) {
        resolve({ ok: false, error: "extension_context" });
      }
    });
  }

  // Called before a fresh decision paints: rings, chips and stale overlays from
  // the previous page/decision must never pile up.
  function resetForDecision(calls) {
    ensureRoot();
    cancelHighlightRetry();
    clearHighlight();
    clearChips();
    if (layers) layers.hint.textContent = "";
    const names = [];
    if (Array.isArray(calls)) for (const c of calls) if (c && c.tool) names.push(c.tool);
    if (names.indexOf("block_page") === -1) clearBlock();
    if (names.indexOf("warn_kid") === -1) clearWarn();
  }

  function runToolCalls(calls, reset) {
    if (!Array.isArray(calls)) return;
    if (reset) resetForDecision(calls);
    for (const call of calls) {
      if (!call) continue;
      const fn = TOOLS[call.tool];
      if (!fn) {
        if (console.debug) console.debug("[KidGuard] unknown tool", call.tool);
        continue;
      }
      try {
        fn(call.args || {});
      } catch (err) {
        if (console.debug) console.debug("[KidGuard] tool failed", call.tool, err);
      }
    }
  }

  /* ----------------------------------------------------------------- scrape */

  function scrape() {
    const body = document.body;
    const text = body && body.innerText ? body.innerText.slice(0, MAX_TEXT) : "";
    return {
      url: location.href,
      title: document.title,
      text: text,
      signals: {
        hasPasswordInput: !!document.querySelector('input[type="password"]'),
        hasForm: !!document.querySelector("form"),
        inputCount: document.querySelectorAll("input").length
      }
    };
  }

  let lastSentText = null;
  let lastSentUrl = null;

  // Digits are blanked so a ticking countdown (clickbait.html) does not read as
  // "the page changed" and burn a second slow model call.
  function textSignature(text) {
    return String(text || "")
      .replace(/\d+/g, "#")
      .replace(/\s+/g, " ")
      .trim();
  }

  let inFlight = false;
  let pendingCheck = false;

  async function check(force) {
    // Paused means paused: no page decision, no wake-up call to the slow model.
    if (sessionPaused) return;
    if (inFlight) {
      // One decision at a time. A forced check (new URL) is replayed after.
      if (force) pendingCheck = true;
      return;
    }
    const payload = scrape();
    const signature = textSignature(payload.text);
    if (!force && signature === lastSentText && payload.url === lastSentUrl) return;

    inFlight = true;
    ensureRoot();
    clearThinking();
    clearToasts();
    // Only show a thinking toast if the backend is actually slow (fast demo stays clean).
    thinkingTimer = setTimeout(() => {
      thinkingEl = toast("Still checking this page…", 60000);
    }, 450);
    try {
      let res = await send({ type: "KG_DECIDE", payload: payload });
      // The service worker may have been asleep or mid-restart: one cheap retry.
      if (res && !res.ok && (res.error === "no_response" || res.error === "extension_context")) {
        await new Promise((r) => setTimeout(r, 400));
        res = await send({ type: "KG_DECIDE", payload: payload });
      }

      lastSentText = signature;
      lastSentUrl = payload.url;
      clearThinking();
      clearToasts();

      if (!res || !res.ok) {
        ensureRoot();
        const spot = defaultMascotSpot();
        emitMascot("idle", spot.x, spot.y, null);
        if (res && res.error === "backend_unreachable") {
          toast("My buddy timed out or is offline. Keep LIVE mode and wait, then refresh.");
        }
        // Happens when the extension is reloaded while the page stays open.
        if (res && res.error === "extension_context") toast("KidGuard was updated - refresh this page.", 6000);
        return;
      }
      runToolCalls(res.tool_calls, true);
      // If Gemma forgot move_mascot, still react from the primary action.
      const tools = Array.isArray(res.tool_calls) ? res.tool_calls.map((c) => c && c.tool) : [];
      if (!tools.includes("move_mascot")) {
        const spot = defaultMascotSpot();
        if (tools.includes("block_page") || tools.includes("warn_kid")) emitMascot("worry", spot.x, spot.y, null);
        else if (tools.includes("allow_page") || tools.includes("highlight_element")) emitMascot("happy", spot.x, spot.y, null);
      }
      // Block/warn cards already carry the message — skip a duplicate toast on those.
      if (res.kid_message && !tools.includes("block_page") && !tools.includes("warn_kid")) {
        toast(String(res.kid_message).slice(0, 120), 5000);
      }
    } finally {
      // Drop the thinking toast/timer even if something threw mid-flight.
      clearThinking();
      inFlight = false;
      if (pendingCheck) {
        pendingCheck = false;
        scheduleRecheck(300);
      }
    }
  }

  /* ------------------------------------------------- SPA / history awareness */

  let watchedUrl = location.href;
  let recheckTimer = 0;

  function scheduleRecheck(delay) {
    clearTimeout(recheckTimer);
    recheckTimer = setTimeout(() => {
      recheckTimer = 0;
      check(true);
    }, typeof delay === "number" ? delay : 600);
  }

  // History patched in the page world is invisible from this isolated world, so
  // the URL is watched instead: popstate/hashchange plus a 1 s string compare.
  function onUrlMaybeChanged() {
    if (location.href === watchedUrl) return;
    watchedUrl = location.href;
    scheduleRecheck(500);
  }

  window.addEventListener("popstate", onUrlMaybeChanged, { passive: true });
  window.addEventListener("hashchange", onUrlMaybeChanged, { passive: true });
  window.addEventListener(
    "pageshow",
    (e) => {
      if (e && e.persisted) scheduleRecheck(200); // restored from bfcache
    },
    { passive: true }
  );
  setInterval(onUrlMaybeChanged, 1000);

  /* -------------------------------------------------- public seam + startup */

  window.__KIDGUARD__ = {
    onMascot(cb) {
      if (typeof cb !== "function") return () => {};
      mascotSubscribers.push(cb);
      return () => {
        mascotSubscribers = mascotSubscribers.filter((f) => f !== cb);
      };
    },
    getHighlightRect() {
      return highlightState ? highlightState.rect : null;
    },
    getMascotHost() {
      ensureRoot();
      return layers.mascotHost;
    },
    setMascotRendererReady() {
      mascotRendererReady = true;
      ensureRoot();
      const blob = layers.mascotHost.querySelector('[data-kidguard-placeholder="true"]');
      if (blob) blob.remove();
    },
    runToolCalls: runToolCalls,
    recheck: () => check(true),
    isPaused: () => sessionPaused
  };

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "KG_RUN_TOOLS") {
      const payload = msg.payload || {};
      const calls = payload.tool_calls;
      // Coach guidance should add highlights/mascot/chips without wiping the page decision.
      runToolCalls(calls, payload.from_coach ? false : true);
      if (payload.from_coach && payload.reply) {
        toast(String(payload.reply).slice(0, 140), 6000);
      }
    }
    if (msg && msg.type === "KG_RECHECK") check(true);
  });

  // Pause/resume happen elsewhere (another tab, the side panel), so follow the
  // shared storage flag rather than waiting for a message.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes) return;
      const flag = changes[PAUSE_KEYS.paused];
      if (!flag) return;
      if (flag.newValue === true) {
        const r = changes[PAUSE_KEYS.reason];
        if (!sessionPaused) applyPaused((r && r.newValue) || pauseReason);
      } else if (sessionPaused) {
        clearPaused();
        scheduleRecheck(400); // repaint this page's own decision
      }
    });
  } catch (_) {
    /* storage permission missing: pause still works within this page */
  }

  window.addEventListener(
    "resize",
    () => {
      if (highlightState) return; // the ring's own resize listener repositions
      const spot = defaultMascotSpot();
      if (layers) layers.mascotHost.style.transform = "translate(" + spot.x + "px," + spot.y + "px)";
    },
    { passive: true }
  );

  ensureRoot();
  const spot0 = defaultMascotSpot();
  layers.mascotHost.style.transform = "translate(" + spot0.x + "px," + spot0.y + "px)";

  // A paused session outlives the page: read the flag before asking anything.
  async function boot() {
    const stored = await readPausedState();
    if (stored && stored[PAUSE_KEYS.paused] === true) {
      applyPaused(stored[PAUSE_KEYS.reason] || "");
      return;
    }
    check(true);
    // Late DOM settle: only re-scrape if we have not already blocked/warned.
    setTimeout(() => {
      if (sessionPaused) return;
      if (layers && layers.stage && layers.stage.classList.contains("kg-blocking")) return;
      if (layers && layers.warn && layers.warn.childNodes.length) return;
      check(false);
    }, 1800);
  }

  boot();
})();
