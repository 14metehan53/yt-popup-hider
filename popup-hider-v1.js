(() => {
  // --- Kill previous instances ---
  const token = Math.random().toString(36).slice(2);
  window.__POPUP_HIDER_TOKEN__ = token;

  const TAG = "[POPUP-HIDER]";
  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  const CONFIG = {
    keepAliveIntervalMs: 900,

    // Manual intent
    manualPauseGestureWindowMs: 900,

    // Popup detection tuning
    popupZIndexMin: 900,
    smallPopupMinAreaRatio: 0.012,
    largePopupCoverRatio: 0.60,
    scrimCoverRatio: 0.75,
    scanThrottleMs: 120,
    undimWindowMs: 30000,

    // Selector memory
    maxKnownSelectors: 12,
  };

  const state = {
    // Known popup selectors (id preferred; safe-ish classes)
    knownSelectors: new Set(),

    userPaused: false,
    lastGestureAt: 0,
    lastManualPauseAt: 0,

    lastPopupSeenAt: 0,

    video: null,
    videoSrc: "",

    onVideoPause: null,
    onVideoPlay: null,
    onVideoLoaded: null,
    onGesture: null,
  };

  const processed = new WeakSet();

  const alive = () => window.__POPUP_HIDER_TOKEN__ === token;
  const shouldUndim = () => Date.now() - state.lastPopupSeenAt < CONFIG.undimWindowMs;

  const cleanup = (mo, intervalId, onFocus, onVis) => {
    try { mo?.disconnect(); } catch {}
    try { clearInterval(intervalId); } catch {}
    try { window.removeEventListener("focus", onFocus, true); } catch {}
    try { document.removeEventListener("visibilitychange", onVis, true); } catch {}

    try {
      if (state.onGesture) {
        document.removeEventListener("pointerdown", state.onGesture, true);
        document.removeEventListener("keydown", state.onGesture, true);
      }
    } catch {}

    try {
      if (state.video) {
        if (state.onVideoPause) state.video.removeEventListener("pause", state.onVideoPause, true);
        if (state.onVideoPlay) state.video.removeEventListener("play", state.onVideoPlay, true);
        if (state.onVideoLoaded) {
          state.video.removeEventListener("loadeddata", state.onVideoLoaded, true);
          state.video.removeEventListener("canplay", state.onVideoLoaded, true);
        }
      }
    } catch {}
  };

  const isVisibleEl = (node) => {
    if (!node) return false;
    const r = node.getBoundingClientRect();
    const s = getComputedStyle(node);
    if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
    if (r.width <= 1 || r.height <= 1) return false;
    return true;
  };

  const isVideoish = (el) => {
    if (!el) return false;
    if (el.tagName === "VIDEO") return true;
    try { if (el.closest?.("video")) return true; } catch {}
    try { if (el.querySelector?.("video")) return true; } catch {}
    return false;
  };

  const hide = (node) => {
    if (!node || node === document.body || node === document.documentElement) return false;
    if (processed.has(node)) return false;

    // NEVER hide video or video containers
    if (isVideoish(node)) return false;

    processed.add(node);
    try { node.dataset.popupHiderHidden = "1"; } catch {}

    node.style.setProperty("display", "none", "important");
    node.style.setProperty("visibility", "hidden", "important");
    node.style.setProperty("pointer-events", "none", "important");
    return true;
  };

  const parseBgAlpha = (bg) => {
    if (!bg || bg === "transparent") return 0;
    const m = bg.match(/rgba?\(([^)]+)\)/i);
    if (!m) return 1;
    const parts = m[1].split(",").map(x => x.trim());
    if (parts.length < 4) return 1;
    const a = Number(parts[3]);
    return Number.isFinite(a) ? a : 1;
  };

  const numZ = (z) => {
    const n = Number.parseInt(z, 10);
    return Number.isFinite(n) ? n : 0;
  };

  const hasCloseAffordance = (el) => {
    try {
      const q = el.querySelector?.(
        "button[aria-label*='close' i],button[title*='close' i],button[class*='close' i]," +
        "button[aria-label*='kapat' i],button[title*='kapat' i],button[class*='kapat' i]," +
        "[aria-label*='close' i],[aria-label*='kapat' i]"
      );
      if (q) return true;

      // bazı popup'larda '×' text'i olur
      const t = (el.innerText || "").slice(0, 800);
      if (t.includes("×")) return true;
    } catch {}
    return false;
  };

  const isLikelyPopup = (el) => {
    if (!el || el === document.body || el === document.documentElement) return false;
    if (!isVisibleEl(el)) return false;
    if (isVideoish(el)) return false;

    // Strong signals
    try {
      if (el.matches?.("[role='dialog'],dialog,[aria-modal='true']")) return true;
      if (el.closest?.("[role='dialog'],dialog,[aria-modal='true']")) return true;
      if (el.matches?.(".modal,.overlay,.backdrop,.dialog")) return true;
    } catch {}

    const r = el.getBoundingClientRect();
    const vw = innerWidth, vh = innerHeight;
    const areaRatio = (r.width * r.height) / (vw * vh);

    const s = getComputedStyle(el);
    const posOk = ["fixed", "absolute", "sticky"].includes(s.position);
    if (!posOk) return false;

    const z = numZ(s.zIndex);
    const bgA = parseBgAlpha(s.backgroundColor);
    const op = Number(s.opacity || "1");
    const effA = (Number.isFinite(op) ? op : 1) * bgA;
    const hasBackdrop = s.backdropFilter && s.backdropFilter !== "none";

    const coversLarge = r.width >= vw * CONFIG.largePopupCoverRatio && r.height >= vh * CONFIG.largePopupCoverRatio;

    // Large overlays: classic modal / interstitial
    if (coversLarge && (effA >= 0.05 || hasBackdrop || z >= CONFIG.popupZIndexMin)) return true;

    // Smaller popups: require higher z-index AND close affordance / strong UI cue
    if (
      areaRatio >= CONFIG.smallPopupMinAreaRatio &&
      z >= CONFIG.popupZIndexMin &&
      (hasCloseAffordance(el) || effA >= 0.08 || hasBackdrop)
    ) return true;

    return false;
  };

  const isLikelyScrim = (el) => {
    if (!el || el === document.body || el === document.documentElement) return false;
    if (!isVisibleEl(el)) return false;
    if (isVideoish(el)) return false;

    const r = el.getBoundingClientRect();
    const vw = innerWidth, vh = innerHeight;
    const covers = r.width >= vw * CONFIG.scrimCoverRatio && r.height >= vh * CONFIG.scrimCoverRatio;

    const s = getComputedStyle(el);
    const posOk = ["fixed", "absolute", "sticky"].includes(s.position);
    if (!covers || !posOk) return false;

    const bgA = parseBgAlpha(s.backgroundColor);
    const op = Number(s.opacity || "1");
    const effA = (Number.isFinite(op) ? op : 1) * bgA;
    const hasBackdrop = s.backdropFilter && s.backdropFilter !== "none";

    return effA >= 0.05 || hasBackdrop;
  };

  const addKnownSelector = (el) => {
    try {
      if (!el || el === document.body || el === document.documentElement) return;
      if (isVideoish(el)) return;

      if (el.id) {
        const sel = `#${CSS.escape(el.id)}`;
        state.knownSelectors.add(sel);
      } else if (el.classList && el.classList.length >= 2) {
        // safer than single class (too broad)
        const cls = [...el.classList].slice(0, 4).map(CSS.escape).join(".");
        if (cls) state.knownSelectors.add("." + cls);
      }

      // cap size
      if (state.knownSelectors.size > CONFIG.maxKnownSelectors) {
        const first = state.knownSelectors.values().next().value;
        state.knownSelectors.delete(first);
      }
    } catch {}
  };

  const undimPage = () => {
    if (!shouldUndim()) return;

    const cls = [
      "modal-open",
      "ReactModal__Body--open",
      "ReactModal__Body--before-open",
      "ant-modal-open",
      "swal2-shown",
      "overflow-hidden",
      "no-scroll",
      "is-locked",
    ];

    try { cls.forEach(c => document.body.classList.remove(c)); } catch {}
    try { cls.forEach(c => document.documentElement.classList.remove(c)); } catch {}

    document.documentElement.style.overflow = "auto";
    document.body.style.overflow = "auto";

    const roots = [
      document.documentElement,
      document.body,
      document.querySelector("#app"),
      document.querySelector("#root"),
      document.querySelector("main"),
    ].filter(Boolean);

    for (const r of roots) {
      const s = getComputedStyle(r);
      if (s.filter && s.filter !== "none") r.style.setProperty("filter", "none", "important");
      if (s.backdropFilter && s.backdropFilter !== "none") r.style.setProperty("backdrop-filter", "none", "important");
      const op = Number(s.opacity || "1");
      if (Number.isFinite(op) && op < 1) r.style.setProperty("opacity", "1", "important");
    }
  };

  // --- Gesture tracking ---
  const attachGestureListeners = () => {
    if (state.onGesture) return;
    state.onGesture = () => { state.lastGestureAt = Date.now(); };
    document.addEventListener("pointerdown", state.onGesture, true);
    document.addEventListener("keydown", state.onGesture, true);
  };

  // --- Autoplay / manual pause guard ---
  const tryAutoPlay = (reason = "") => {
    if (!alive()) return;

    const v = state.video;
    if (!v) return;

    undimPage();

    if (state.userPaused) return;
    if (!v.paused) return;

    const p = v.play();
    if (p && typeof p.catch === "function") {
      p.catch((e) => warn(`play() blocked (${reason}):`, e));
    }
  };

  const attachVideoListeners = () => {
    const v = document.querySelector("video");
    if (!v) return;

    const src = v.currentSrc || v.src || "";
    const videoElChanged = state.video !== v;
    const srcChanged = !!src && src !== state.videoSrc;

    if (videoElChanged || srcChanged) {
      if (state.video) {
        try {
          if (state.onVideoPause) state.video.removeEventListener("pause", state.onVideoPause, true);
          if (state.onVideoPlay) state.video.removeEventListener("play", state.onVideoPlay, true);
          if (state.onVideoLoaded) {
            state.video.removeEventListener("loadeddata", state.onVideoLoaded, true);
            state.video.removeEventListener("canplay", state.onVideoLoaded, true);
          }
        } catch {}
      }

      state.video = v;
      state.videoSrc = src;

      // new video => don't carry manual pause lock
      state.userPaused = false;
      state.lastManualPauseAt = 0;

      log("New video detected → autoplay allowed.", { src });
      setTimeout(() => tryAutoPlay("new-video"), 0);
    } else {
      if (state.onVideoPause && state.onVideoPlay && state.onVideoLoaded) return;
      state.video = v;
      state.videoSrc = src;
    }

    state.onVideoPause = () => {
      if (!alive()) return;
      if (!document.hidden && document.hasFocus()) {
        const recentGesture = Date.now() - state.lastGestureAt < CONFIG.manualPauseGestureWindowMs;
        if (recentGesture) {
          state.userPaused = true;
          state.lastManualPauseAt = Date.now();
          log("Manual pause detected → auto-resume locked until manual play.");
        }
      }
    };

    state.onVideoPlay = () => {
      if (!alive()) return;

      const recentGesture = Date.now() - state.lastGestureAt < 1200;
      const gestureAfterPause = state.lastGestureAt > state.lastManualPauseAt;

      if (state.userPaused && !(recentGesture && gestureAfterPause)) {
        try {
          state.video.pause();
          log("Play blocked (manual pause active, no valid gesture after pause).");
        } catch {}
        return;
      }

      if (state.userPaused && recentGesture && gestureAfterPause) {
        state.userPaused = false;
        log("Manual play detected → auto-resume unlocked.");
      }
    };

    state.onVideoLoaded = () => {
      if (!alive()) return;
      tryAutoPlay("loadeddata/canplay");
    };

    v.addEventListener("pause", state.onVideoPause, true);
    v.addEventListener("play", state.onVideoPlay, true);
    v.addEventListener("loadeddata", state.onVideoLoaded, true);
    v.addEventListener("canplay", state.onVideoLoaded, true);
  };

  // --- Popup scanning ---
  let scanScheduled = false;
  let lastScanAt = 0;

  const points = () => {
    const vw = innerWidth, vh = innerHeight;
    return [
      [vw * 0.5, vh * 0.5],   // center
      [vw * 0.85, vh * 0.2],  // top-right-ish
      [vw * 0.15, vh * 0.2],  // top-left-ish
      [vw * 0.85, vh * 0.8],  // bottom-right-ish
      [vw * 0.15, vh * 0.8],  // bottom-left-ish
    ];
  };

  const scanAndHideAtPoint = (x, y) => {
    const stack = (document.elementsFromPoint ? document.elementsFromPoint(x, y) : [document.elementFromPoint(x, y)]).filter(Boolean);

    // 1) popups first (stronger)
    for (const el of stack) {
      // climb up a bit to catch wrapper
      let cur = el;
      let depth = 0;
      while (cur && cur !== document.body && cur !== document.documentElement && depth < 8) {
        if (isLikelyPopup(cur)) {
          if (hide(cur)) {
            state.lastPopupSeenAt = Date.now();
            addKnownSelector(cur);
            undimPage();
            return true;
          }
          return false;
        }
        cur = cur.parentElement;
        depth++;
      }
    }

    // 2) scrims/backdrops (only after we saw popup recently OR if scrim is very obvious)
    for (const el of stack) {
      if (isLikelyScrim(el)) {
        if (hide(el)) {
          state.lastPopupSeenAt = Date.now();
          undimPage();
          return true;
        }
      }
    }

    return false;
  };

  const hideKnownSelectors = () => {
    if (state.knownSelectors.size === 0) return false;
    let hid = false;
    for (const sel of state.knownSelectors) {
      try {
        document.querySelectorAll(sel).forEach((n) => {
          if (isLikelyPopup(n) || isLikelyScrim(n)) {
            if (hide(n)) {
              hid = true;
              state.lastPopupSeenAt = Date.now();
            }
          }
        });
      } catch {}
    }
    if (hid) undimPage();
    return hid;
  };

  const scanNow = (reason = "") => {
    if (!alive()) return;
    const now = Date.now();
    if (now - lastScanAt < CONFIG.scanThrottleMs) return;
    lastScanAt = now;

    attachGestureListeners();
    attachVideoListeners();

    // 1) If we have known selectors, hide them
    const hidBySelector = hideKnownSelectors();

    // 2) Sample a few points to catch new/different popups
    let hidByPoints = false;
    for (const [x, y] of points()) {
      if (scanAndHideAtPoint(x, y)) hidByPoints = true;
    }

    // If we hid a popup/scrim, we may safely try to resume (unless manual pause)
    if (hidBySelector || hidByPoints) {
      tryAutoPlay(`scan(${reason})`);
    }
  };

  const scheduleScan = (reason = "") => {
    if (!alive()) return;
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      scanNow(reason);
    });
  };

  // --- Start observers/timers (always on, so future popups are handled) ---
  attachGestureListeners();
  attachVideoListeners();
  scheduleScan("initial");

  const mo = new MutationObserver((mutations) => {
    if (!alive()) return;

    // Fast-path: check added nodes directly (helps immediate suppression)
    for (const m of mutations) {
      for (const n of m.addedNodes || []) {
        if (!(n instanceof Element)) continue;

        // if a new dialog-like node appears, hide it immediately
        let cur = n;
        let depth = 0;
        while (cur && cur !== document.body && cur !== document.documentElement && depth < 8) {
          if (isLikelyPopup(cur) || isLikelyScrim(cur)) {
            if (hide(cur)) {
              state.lastPopupSeenAt = Date.now();
              addKnownSelector(cur);
              undimPage();
            }
            break;
          }
          cur = cur.parentElement;
          depth++;
        }
      }
    }

    // Throttled full scan (catches re-renders / style toggles)
    scheduleScan("mutation");
  });

  mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true });

  const onFocus = () => scheduleScan("focus");
  const onVis = () => scheduleScan("visibility");

  window.addEventListener("focus", onFocus, true);
  document.addEventListener("visibilitychange", onVis, true);

  const intervalId = setInterval(() => {
    if (!alive()) {
      cleanup(mo, intervalId, onFocus, onVis);
      return;
    }
    scheduleScan("tick");
  }, CONFIG.keepAliveIntervalMs);

  window.__POPUP_HIDER__ = {
    stop: () => {
      if (alive()) window.__POPUP_HIDER_TOKEN__ = "stopped";
      cleanup(mo, intervalId, onFocus, onVis);
      log("Stopped.");
    },
    debug: {
      getKnownSelectors: () => [...state.knownSelectors],
      forceScan: () => scanNow("manual"),
    },
  };

  log("Active. Popup suppression + autoplay guard (manual pause respected).");
})();