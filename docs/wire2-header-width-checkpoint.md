# Header width checkpoint — native 175% clamp

Status: fix implemented, red-to-green native reproduction, full automated checks passed. **Said's real-display verification remains OPEN.** No commits, restart, reload, or interaction with the running Glass/server.

## Live evidence

The supplied header-width-v1 JSON reports:
- devicePixelRatio 1.75, visualViewport scale 1.
- Header content width 461.96; clientWidth/scrollWidth 462.
- Renderer viewport 356; outerWidth 357.
- Settings occupies x=419.96 through 451.96, entirely outside the viewport.
- Requested probe: 462 × 47.
- Main-process reply: applied:false, width:357, height:50.
- After probe, viewport remains 356.
- No renderer last-width cache, no pending resize, and sizing is not suspended before the probe.

The approximately 105-DIP width loss is native rejection, not ordinary 1–2 DIP rounding or a stale renderer last-width cache. The private main-process cache was not observable from that live snippet.

## Root cause

The header is constructed with resizable:false. At 175%, Windows already pins its native min/max to roughly the initial window size before our first query:
- native bounds: 356 × 50;
- minimum and maximum: [355,49].

The previous fix captured those values with getWindowSizeLimits and treated them as configured limits. Unlocking then restored that accidental maximum. Consequently, 462 × 47 was clamped to 357 × 50. The native regression through the real windowManager reproduced exactly the width and height in Said's reply.

The earlier header screenshot harness used direct native resizing, bypassing this construction/limit-registration path. Its screenshot was insufficient evidence of the real-window result.

A separate confirmed bug existed on the width axis: animateResize checked height before deciding whether to reconcile requestedSizes. If height applied but width was rejected, the later header reply correctly said applied:false while the layout cache could still contain the rejected width. A regression pins this case.

## Changes

- [windowManager.js](../src/window/windowManager.js:33): construct managed windows through a factory that immediately registers the explicit constructor size limits. Header, Listen, Ask, Settings and shortcut editor retain their configured constraints; missing min/max options mean unrestricted (0), not whatever a locked native window currently reports.
- [windowBounds.js](../src/window/windowBounds.js:25): registerWindowSizeLimits stores that construction intent. Native read fallback remains for unmanaged windows. The prior anti-growth bookkeeping and two-DIP rounding allowance remain.
- [windowResize.js](../src/window/windowResize.js:4): optional requested width is checked alongside height. Failure on either requested axis reconciles against actual getBounds(), even if the other axis succeeds.
- [windowManager.js](../src/window/windowManager.js:173): pass requested width into the resize operation; reply continues to use actual bounds.
- tests/helpers/native-resize.cjs and tests/native-resize.test.js: test real managed header construction, explicit scale factor 1.75, actual renderer viewport, repeated locking/resizing and stable requested-width bookkeeping. Existing 224px-to-meeting height and configured 900px cap checks remain.
- tests/window-attachment.test.js: prove rejected width is removed from the main-process layout cache and a subsequent retry applies.

No renderer UI changes in this fix. All earlier restored controls and source/lifecycle boundaries remain. Listener source/tests and provider configuration are untouched.

## Red-to-green evidence

Evidence directory: wire2-header-width-evidence/.

- native-red.tap: native request 462 × 47 failed with bounds 357 × 50, applied:false. Initial native min=max=[355,49].
- cache-red.tap: rejected native width 357 left 462 cached when height succeeded.
- native-cache-green.tap: 30/30 focused tests passed after the fixes.
- native-final.tap: real native geometry and renderer measurement:
  - requested 462 × 47;
  - applied native bounds 464 × 48, applied:true;
  - renderer viewport 463 × 48, devicePixelRatio 1.75;
  - after 520 → 462 resizing, actual width 464 while cached intended width remains 462.
- This small positive rounding difference is accepted without using it as the next drag/resize request. Constructor-pinned limits are not accepted as configuration.

## Final full checks

| Check | Node 20.20.2 | Node 24.13.1 |
| --- | --- | --- |
| Glass | 292 passed, 0 failed | 292 passed, 0 failed |
| Listener, unchanged | 184 passed, 0 failed | 184 passed, 0 failed |
| Renderer build | Successful | Successful |

Raw TAP and build output are stored in this evidence directory. Glass has 261 top-level tests plus 31 nested subtests, totaling 292. All four full-suite runs for this checkpoint passed without reruns.

## Required live re-check

Load the rebuilt Glass main process at a time Said chooses; a renderer-only reload cannot load these main-process changes. Leave the listener running.

On the real 175% display, take a screenshot showing the entire header, including the Show/Hide backslash shortcut and the rightmost three-dot Settings control. Check Settings opens, and check the stopped header with Done too.

The same header diagnostic snippet can additionally confirm viewport width is at least the measured content requirement and an explicit resize returns applied:true. Do not paste settings or keys.

**The real-display width check stays open until Said's screenshot confirms the full header.** The physical mouse-wheel and live bottom-follow checks from the overlay task remain open as well. No commits until live acceptance.
