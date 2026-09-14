# Meeting resize fix checkpoint

The approved fix is implemented and automated checks pass. No commit was made. The running Glass/server were not restarted or reloaded. **Real-overlay wheel scrolling and live-feed bottom-follow remain unverified and must pass the live re-check before any commit.**

## Result and cause

The supplied live capture showed a 613.71px layout inside a 225px viewport, with the renderer caching 614px. Main and renderer had the same eight rows and state. The transcript's 280px scroll element was clipped; Suggestions was entirely below the viewport.

The native regression reproduced the cause: after locking a previously resized window, Windows reports min/max sizes both as its current 224px height. The old code clamped the requested 614px against those native limits before unlocking. Its final native height was 225px. The original [red output](wire2-resize-evidence/resize-red.tap) has five failing regressions: this clamp and four acknowledgement/queue cases.

## Changes

| File | Behavior |
| --- | --- |
| `src/window/windowBounds.js` | Retains configured size limits independently of native locked-window limits; restores them after unlocking; reconciles rejected native sizes without accumulating fractional-DPI rounding. |
| `src/window/windowLayoutManager.js` | Clamps against retained intended limits. |
| `src/window/windowResize.js` | Owns temporary unlocking, intended-limit restoration, animation settlement and relocking. Returns only `{ applied, height }`; errors do not cross IPC. |
| `src/window/windowManager.js` | Unlocks before calculating/applying feature-window resize; resolves existing height IPC after completion/cancellation. Header resize uses the same lock ownership helper. |
| `src/window/smoothMovementManager.js` | Settles resize ownership on cancellation, destruction and native setter failure. |
| `src/ui/listen/ListenView.js` | Caches only confirmed actual heights within two DIP of the request. Coalesces an in-flight request and keeps only the latest changed measurement. Failed/rejected requests stay retryable on a subsequent update. |
| `tests/native-resize.test.js`, `tests/helpers/native-resize.cjs` | Real Electron/Windows locked-limit regression at 175%, applied acknowledgement, original 900px cap and restored resize lock. |
| `tests/listen-resize-ack.test.js` | Pending/rejected/failed acknowledgement, fractional rounding and latest queued measurement. |
| `tests/window-attachment.test.js`, `tests/helpers/meeting-fixture.html` | Native-limit fake, cancellation/rejection/failure coverage, and realistic applied acknowledgements in renderer fixtures. |

No feed, Ask, STT, SummaryService, repository or provider-setting behavior changed. Existing bridge/preload methods already return the height IPC result; no new channel or credential surface is needed.

## Real verification

| Check | Node 20.20.2 | Node 24.13.1 |
| --- | --- | --- |
| Full Glass suite | [273 passed / 0 failed](wire2-resize-evidence/glass-node20.tap) | [273 passed / 0 failed](wire2-resize-evidence/glass-node24.tap) |
| Unchanged listener suite | [184 passed / 0 failed](wire2-resize-evidence/listener-node20.tap) | [184 passed / 0 failed](wire2-resize-evidence/listener-node24.tap) |
| Renderer build | [Exit 0](wire2-resize-evidence/build-node20.txt) | [Exit 0](wire2-resize-evidence/build-node24.txt) |

Glass reports top-level plan `1..257` plus 16 nested renderer tests, totaling 273. No skipped, cancelled or todo tests. The final focused resize run passed [31/31](wire2-resize-evidence/resize-focused.tap).

A new cancellation/limit test initially found one extra DIP of growth after a request exceeded the configured cap (902 instead of 901 in the rounding fake). The initial [full run](wire2-resize-evidence/glass-node24-first.tap) preserves that failure. Retaining intended dimensions within the existing two-DIP native rounding tolerance fixed it; the final suites above are green.

### Built-app/native-window check

The separate hidden test loaded the newly built `public/build/content.js`, actual content HTML and source window manager/movement modules with synthetic feed IPC. No live services, capture or database were loaded. It uses a temporary profile and suppresses visible windows; it does **not** test physical mouse input.

[Raw built-app evidence](wire2-resize-evidence/built-app-fixed-output.txt):

- Before switching: native viewport 224px, local layout 222.57px; confirmed cache 224px.
- After switching to Meeting: viewport **615px**, layout **613.71px**, confirmed cache **615px**.
- Transcript: eight rows, clientHeight 280, scrollHeight 556; automatic following reached **scrollTop 276**.
- Programmatic scroll changed scrollTop to **200**.
- Suggestions host starts at y=377.71, inside the corrected viewport.
- Only two height requests were issued: initial 223 and Meeting 614. Eight row updates did not cause repeated resizes.

The diagnostic-only unlock workaround used during investigation is absent from this verification; the production fix owns resizing. The portable evidence harness is `wire2-resize-evidence/verify-built-app.cjs` with `built-app-preload.cjs`. It can be run using the installed Electron executable after a renderer build.

Full-suite commands, from Glass: `node --test --test-reporter=tap tests/*.test.js`; on Node 20, expand the test paths with PowerShell `Get-ChildItem tests -Filter '*.test.js'` and pass them to `../realtime_listener/logs/node20.exe --test --test-reporter=tap`. From listener, use each runtime with `--test --test-reporter=tap`. Both builds use the corresponding runtime with `build.js`.

## Live checkpoint — still open

The already-running Glass process still has its previous code loaded. When ready for the live re-check, Stop and quit Glass, then relaunch it from the same configured terminal so its main-process token environment remains available. Keep the server running.

1. Select Meeting and Listen. Confirm the complete transcript and Suggestions regions are visible and the overlay has the correct height.
2. Use the physical mouse wheel in the transcript pane to reach newer and older rows. This check is **OPEN**, not covered by programmatic scrolling.
3. At the bottom, let new live speech arrive and confirm bottom-follow. Scroll up and confirm new arrivals preserve the reading position.

Return PASS/FAIL for window size, mouse wheel and live bottom-follow. Report any clipping or jitter. No commit until these live checks pass. The earlier two live console errors and warning were not supplied, so their exact contents remain unclassified.

[Final scope/secret verification](wire2-resize-evidence/final-verification.txt) and [both repository statuses](wire2-resize-evidence/git-status-both.txt) accompany this checkpoint.
