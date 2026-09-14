# Three live issues checkpoint

No commits, live-process restarts, or live-window manipulation. Additions-only preserved.

## 1. Connecting feed — operational console pause, recovered

The running listener was blocked, not dead and not rejecting Glass's token.

Evidence, in the requested order:
1. PID 42056 (node.exe, started 19:47:35Z) was alive. TCP port 11434 was listening on both 127.0.0.1 and ::1. The session had recorded http.listening at 19:47:37.009Z. However, both /api/tags probes timed out after approximately 2.5 seconds. A bound port alone did not establish a responsive HTTP server.
2. At 21:01:20Z, the latest JSONL timestamp was still 20:43:59.294Z: 643 events, 554 http.request records, and no http.error records. Three /v1/live/events requests had previously reached the handler, at 19:49:06.539Z, 19:57:19.795Z, and 19:57:55.621Z. During the stall, retries could reach the OS socket queue without reaching application logging. Several CloseWait connections accumulated.
3. Before recovery, the last recorded Fireflies reconnect/auth success was 19:56:42Z; the frozen event loop made current socket health unobservable. After recovery, Fireflies reconnected at 21:03:20.244Z and authentication succeeded at 21:03:22.371Z. Incoming chunks resumed.
4. Startup recorded v1Auth:false. The server's effective WRAPPER_TOKEN policy therefore required no bearer token. A different/missing token in a newly launched Glass shell could not explain this failure. No 401s were logged. We did not dump or compare process environment values; comparison was unnecessary for this unauthenticated server policy.

Said pressed Escape in the listener PowerShell window and reported that output resumed. Without changing code or restarting either process:
- Both /api/tags probes returned HTTP 200 in 9ms.
- Log count rose from 643 to 788; accepted chunk count rose from 27 to 45 by 21:03:50Z.
- Previously pending SSE attempts reached the handler around 21:03:19Z. A later request arrived at 21:03:22.645Z.
- Glass main PID 54024 had an established connection to port 11434.
- An explicitly identified diagnostic SSE subscriber received HTTP 200 and a snapshot with connectionState connected, availability available, sequence 90, revision 57, 5 buffered chunks, 11 retained suggestion outcomes, generation idle, closed false.
- The latest recorded suggestion attempt was 21:05:17.688Z and its subsequent suggestion record was 21:05:25.518Z.
- Said confirmed: “Yes, transcript is flowing.”

Root cause: the Windows listener console was paused by text selection. Escape released the pause. **No feed/subscriber/auth code fix or restart was needed.** Avoid leaving text selected in that console during a meeting; Escape is the recovery if output pauses again.

The log records route entry after authentication, not a per-request response status for every successful SSE connection. We do not claim historical 200 status codes from those route records alone. The diagnostic's 200 and Said's recovered overlay are direct recovery evidence.

Code references: realtime_listener/lib/http-server.js:213-231 (auth then route logging), :343 (listening/auth policy); lib/session-log.js:19 (synchronous append/console output). No listener source or tests changed.

Evidence: [feed-recovery.txt](wire2-live-issues-evidence/feed-recovery.txt). Only timestamps, statuses, counts and booleans were captured, never transcript text or keys.

## 2. Settings overlap — source-aware placement

Cause: windowLayoutManager.calculateSettingsWindowPosition used only the header and Settings bounds, with a fixed +170 horizontal offset and +5 vertical offset. It never checked Listen or Ask rectangles. The feature layout separately positioned Listen and Ask, so Settings could overlap the meeting transcript.

Fix:
- [windowLayoutManager.js:72](../src/window/windowLayoutManager.js:72): retain the exact original positioning formula in Local mode. In Meeting, search nearby free positions beside, above or below the visible Listen/Ask windows, within the current display's work area. Collision checks use native extents and an 8-DIP gap.
- [windowManager.js:52](../src/window/windowManager.js:52): update visible Settings placement when the meeting layout changes, including header movement, pane resize, Ask show/hide, and source selection.
- [listenService.js:44](../src/features/listen/listenService.js:44): publish only the authoritative source name to layout. No feed IDs, transcript rows, tokens, provider state, or repository calls enter this event.
- No window is hidden, shrunk, or removed. If a physical display cannot fit all windows, placement minimizes overlap rather than changing shipped window behavior; real-display verification is still required.

Red evidence: ui-red.tap reproduces “Settings overlaps meeting transcript.” Local's original positioning assertion passes.
Green coverage: meeting placement with/without Ask, resize, dragging near both display edges, negative-coordinate monitors, Local formula preservation, and source-only layout signaling.
Native Windows 175% evidence: native-settings.tap:
- With Ask: Settings x=1404,width=242; Ask x=794,width=603 (right edge 1397); Listen x=385,width=402. No intersections.
- Without Ask: Settings x=1329,width=242; Listen x=920,width=402 (right edge 1322). No intersection.
Native rounding leaves a 7-DIP measured gap in this run; intended layout spacing is 8 DIP.

## 3. Dark selector — explicit header text token

Cause: the added .source-select used color:inherit while MainHeader did not establish a white inherited text color. Shipped labels specify white directly. A normal black body text color therefore produced black selector text.

Fix: [MainHeader.js:13](../src/ui/app/MainHeader.js:13) now uses var(--header-text-color, #fff), with the header token explicitly set to #fff. Existing option styling, focus/selection, disabled state and shipped controls remain.

Red evidence: actual renderer test sets the host/body text to black and reproduces the unreadable inherited selector.
Green: computed selector color is rgb(255, 255, 255) in Local/Meeting and idle/active states.

## Final validation

| Check | Node 20.20.2 | Node 24.13.1 |
| --- | --- | --- |
| Full Glass suite | 296 passed, 0 failed | 296 passed, 0 failed |
| Full listener suite, unchanged | 184 passed, 0 failed | 184 passed, 0 failed |
| Renderer build | Successful | Successful |

Raw outputs: wire2-live-issues-evidence/glass-node20.tap, glass-node24.tap, listener-node20.tap, listener-node24.tap, build-node20.txt, build-node24.txt.
Glass totals are 264 top-level tests plus 32 nested subtests.
Focused tests: 80 passed, 0 failed in ui-green.tap. The native test also verifies the prior header-width and locked-height fixes.

Files changed for this task:
- src/window/windowLayoutManager.js
- src/window/windowManager.js
- src/features/listen/listenService.js (source-only layout notification)
- src/ui/app/MainHeader.js
- tests/window-attachment.test.js
- tests/meeting-lifecycle.test.js
- tests/helpers/meeting-renderer.cjs
- tests/helpers/native-resize.cjs and tests/native-resize.test.js
- This checkpoint and wire2-live-issues-evidence/

Prior accepted-but-uncommitted work remains intact. Secret/scope scan and git diff --check are recorded in final-verification.txt. Both staging areas and commit heads remain unchanged.

## Said's remaining real-display checks

When convenient, fully quit and relaunch Glass to load the main-process placement change; keep the listener running and avoid selecting its console text.

1. In Meeting, confirm the selector text is readable when idle and active.
2. Open Listen, then hover/click Settings. Capture a screenshot showing the whole Settings panel beside the meeting overlay.
3. Open Ask too; confirm Settings overlaps neither pane. Move the header near a screen edge and check placement again.
4. Stop, switch to Local, and confirm Settings retains its normal shipped position.
5. The earlier physical mouse-wheel/bottom-follow overlay checks and full-header screenshot acceptance remain open unless separately confirmed.

Feed recovery is live-confirmed by Said. **Settings placement and selector readability are not yet verified on Said's real display. No commits.**
