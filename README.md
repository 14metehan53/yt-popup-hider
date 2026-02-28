# Popup Hider + Autoplay Guard (Manual-Pause Friendly)

This snippet is designed for video pages (including YouTube-like players) where popups/modals/overlays interrupt playback. It **automatically hides intrusive overlay layers** and **attempts to resume playback** if the video gets paused due to those overlays.

## Quick Usage (No Extensions Needed)

### 1) Open the browser Console
**Chrome / Edge (Windows / Linux)**
1. Open the video page.
2. Press **F12** (or **Ctrl + Shift + I**).
3. Click the **Console** tab.

**Chrome / Edge (macOS)**
1. Open the video page.
2. Press **⌥ Option + ⌘ Command + I**
3. Click the **Console** tab.

**Firefox**
- Windows/Linux: **Ctrl + Shift + K**
- macOS: **⌥ Option + ⌘ Command + K**

> Tip: If you don’t see “Console”, look for a `>>` or “More tools” menu in DevTools.

---

### 2) Paste & run the snippet
1. Copy the entire snippet code.
2. Click inside the Console input area.
3. Paste it (**Ctrl+V** / **⌘V**).
4. Press **Enter** to run.

If you did it correctly, you should see a log like:
- `"[POPUP-HIDER] Active. Popup suppression + autoplay guard (manual pause respected)."`

---

### 3) How to stop it
In the Console, run:

`js
window.__POPUP_HIDER__?.stop?.()

Its core rule is non-negotiable:

> **If the user manually pauses the video, the snippet will never force playback to resume.**  
> Autoplay remains locked until the user explicitly plays again.

It also ensures autoplay continues to work when the page transitions to a **new video** (e.g., next item in a playlist).

Enjoy it :)

---

## What this snippet does

### 1) Prevents duplicate/stacked instances
Each run creates a unique `token` stored in `window.__POPUP_HIDER_TOKEN__`.

- If you paste/run the snippet again, the previous instance becomes inactive via an `alive()` check.
- This prevents multiple MutationObservers/interval loops from running simultaneously and interfering with each other.

---

### 2) Tracks user gestures (required for correct autoplay + manual intent)
Browsers often restrict `video.play()` to only succeed after a real user interaction (gesture).

The snippet listens for:
- `pointerdown`
- `keydown`

…and stores the latest interaction timestamp in `state.lastGestureAt`.

This is critical for:
- determining whether a `pause` was truly manual,
- allowing a “manual play” to unlock autoplay after a manual pause.

---

### 3) Attaches to the `<video>` element and detects “new video” transitions
The snippet targets the first `<video>` element and watches for changes indicating a new video:

- the `<video>` element itself changes, **or**
- the same element’s source changes (`currentSrc` / `src`)

When a new video is detected:
- the manual-pause lock (`userPaused`) is **reset** (manual pause from the previous video does *not* carry over),
- autoplay is attempted again.

This resolves the common issue:
> “I paused one video, and autoplay never works again for the next video.”

---

### 4) Respects manual pause with high precision (the most important behavior)
A `pause` event does **not** automatically mean “user paused it.” Many platforms pause videos programmatically during transitions, ads, or overlays.

The snippet treats a pause as **manual** only if:
- the page is visible and focused, **and**
- a user gesture occurred shortly before the pause

If there was **no recent gesture**, the pause is considered programmatic, and autoplay is **not** locked.

---

### 5) Correctly distinguishes manual play (gesture must occur *after* manual pause)
A subtle pitfall: if the user pauses via keyboard (e.g., Space/K), the same key event can lead to a false “manual play” detection.

To prevent this:
- The snippet records the manual pause time in `lastManualPauseAt`.
- On `play`, it requires that a gesture occurred **after** that pause.

Result:
- When you pause manually, the video actually stays paused.
- Autoplay unlocks only when you *really* press play.

---

### 6) Safely detects popups (never hides the video by mistake)
A key safety guarantee of the final implementation:

> If no popup is detected, the snippet will **not** hide anything.  
> It will never accidentally hide the video element or its container.

Popup detection uses:
- `elementsFromPoint()` at the center of the viewport,
- strong indicators like `role="dialog"`, `aria-modal="true"`, `dialog`, and common classes (`.modal`, `.overlay`, `.backdrop`),
- heuristics based on size coverage, positioning (fixed/sticky), z-index, opacity/background alpha, and backdrop-filter usage.

If no popup is found:
- no DOM element is hidden,
- only the autoplay/guard logic remains active.

---

### 7) Hides the popup and keeps it suppressed if it reappears
When a popup is detected:
- it is hidden using `display: none !important`, `visibility: hidden !important`, and `pointer-events: none !important`.
- a selector is generated (prefer `id`, else a class-based selector when available).

A `MutationObserver` then monitors the DOM:
- if the popup reappears, it is immediately hidden again.

---

### 8) Removes dimming/“dark overlay” effects caused by modals
Many sites don’t just show a dialog — they also dim the entire page using:
- `filter: brightness(...)`
- `opacity: ...`
- `backdrop-filter: blur(...)`

After a popup is detected, the snippet temporarily enables a cleanup window and:
- removes common “modal open” classes,
- restores scrolling (`overflow` locks),
- resets dimming effects on root nodes (`html`, `body`, and common root containers like `#root`, `#app`, `main`).

It can also hide large “scrim/backdrop” layers near the viewport center **without touching the video**.

**Important:** These “undim” operations run only after a popup was actually seen (within a limited time window). On normal pages, the snippet avoids unnecessary global style changes.

---

### 9) Best-effort autoplay attempts (with strict manual-pause lock)
The snippet may attempt `video.play()` in these situations:
- initial run
- after new video detection
- on `loadeddata` / `canplay`
- on focus/visibility changes
- periodic keepalive ticks

It will **never** attempt autoplay when:
- `userPaused === true`

If the browser blocks autoplay, the snippet logs a warning via `console.warn` and continues safely.

---

## How to stop it
When active, the snippet exposes:

- `window.__POPUP_HIDER__`

Call:

- `window.__POPUP_HIDER__.stop()`

This:
- disconnects observers,
- clears intervals,
- removes event listeners,
- fully stops the instance.

---

## Known limitations / notes
- This targets standard HTML5 `<video>`. Some platforms use canvas/iframe-based renderers or custom playback layers; behavior may vary.
- Popup detection is heuristic-based. If selector generation fails (rare), you may need to run the snippet again while the popup is visible.
- On highly dynamic pages, overlays can re-spawn repeatedly; the MutationObserver is designed to suppress these cases.

---

## Safety principles
- Never hides the `<video>` element or containers holding a video.
- If no popup is detected, does not hide arbitrary elements.
- Manual pause is always respected: if the user pauses, autoplay remains disabled until the user plays again.
