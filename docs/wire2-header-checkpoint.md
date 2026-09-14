# Header restoration checkpoint

Status: implemented and automatically verified; no commit, push, restart, or reload of the live stack. Additions-only is the UI rule: keep upstream controls and their existing actions when extending Glass.

Compared pre-phase-3 Glass commit 30f7362 with phase-3 commit a7394e4, then reviewed the working tree. The previous approved resize fix and Phase 4 work are still uncommitted and preserved.

## Findings and complete UI inventory

| Shipped element | Phase-3 effect | Current behavior / evidence |
| --- | --- | --- |
| Right-side Settings / vertical three-dot menu | Not deleted and not capability-gated. These are one control, not separate controls. An undersized native header clips it. | Unconditional control, normal hover behavior, plus click and accessible label. MainHeader.js:756; windowBridge.js:14; windowManager.js:68. |
| Show/Hide label and shortcut boxes | Unchanged markup; can also be clipped at the right edge. | Kept and tested in Local/Meeting, configured/unconfigured, active/stopped; MainHeader.js:744. |
| Ask label and shortcut boxes | Unchanged; no Meeting gate. | Existing request action retained. No Ask service, shortcut, session, or provider changes. MainHeader.js:737. |
| Listen / Stop, recording icon and loading dots | Authoritative lifecycle replaced the optimistic cycle. For users lacking local providers, Listen was relabelled “Set up Local.” | Listen/Stop and existing indicators remain. Listen keeps its name and opens explicit local setup when needed. A separate Setup control exposes connection choices. MainHeader.js:687,735. |
| Done completion action and completion appearance | Replaced with Listen after stopping. | Done restored alongside restart, invokes the existing Done action; no optimistic lifecycle changes. MainHeader.js:569,733; listenService.js:142. |
| Header drag, slide/hide animation and shortcuts | No removal. | Preserved; interactive settings and source selection remain outside the native drag region. |
| Welcome: browser sign-in, personal API-key choice, Quit | Meeting capability bypasses onboarding on entry and provider/auth reevaluation. Not deleted, but initial connection choices were no longer directly reachable from the meeting header. | Added Setup opens the original Welcome screen in either source. Original sign-in, personal keys, and Quit remain; a separate return control goes to source selection. HeaderController.js:92; WelcomeHeader.js:190. |
| API-key screen Back | Redirected from Welcome to Main during local setup. Provider controls and Quit were not deleted. | Original Back-to-Welcome restored. Separate Back-to-source-selection added. Provider validation and requirements unchanged. HeaderController.js:48,184; ApiKeyHeader.js:1951. |
| Permission screen Close/Quit | Repurposed into Back when entered from Meeting-capable MainHeader. | Original Close quits again. A separate Back returns without quitting. PermissionHeader.js:474,489. Extra height prevents the addition covering the title/content. |
| Listen “Show Transcript” / “Show Insights” icons and control | Omitted by the Meeting render branch. Local branch retained. | Restored in Meeting. It focuses the corresponding transcript/suggestion section without hiding either feed pane; Local keeps its original switching behavior. ListenView.js:641,682,785. |
| Listen Copy icon, hover text and copied checkmark | Replaced by a plain Copy button in Meeting. Local branch retained. | Original icon/checkmark/hover affordances restored in Meeting. Copies transcript plus complete suggestions; Local copy behavior unchanged. ListenView.js:659,702. |
| Listen elapsed display and status labels | Meeting used only source/connection status, hiding the elapsed display. | Elapsed display restored alongside explicit Meeting status. Local “Glass is Listening” / “Live insights” labels remain. ListenView.js:639,770. |
| Source-specific transcript rows, local summary content and empty states | Meeting renders speaker-labelled external rows and server suggestions instead of local STT bubbles and the local SummaryView. | Content remains source-specific. Local retains “Current Summary,” topic bullets, Actions, Follow-Ups, their existing links, and empty states (SummaryView.js:452). Meeting navigation targets server suggestions. It does not manufacture local summary data, mount a local summary observer, or feed external rows into SummaryService/history. |
| Normal Settings contents | No phase-3 edits or Meeting gating in SettingsView. | Existing account, providers/models, shortcuts, presets, personalization/meeting notes, updates, move, invisibility, login/logout and Quit remain. Tested browsing with no configured providers; model controls keep their existing requirements. SettingsView.js:1180. |
| Other UI files | No phase-3 changes to AskView, SettingsView, shortcut settings, WelcomeHeader, ApiKeyHeader or SummaryView. PermissionHeader/MainHeader/HeaderController/ListenView/SttView were the changed existing visual components. Audio files changed lifecycle behavior, not shipped controls. | No additional removed controls found in the phase-3 UI diff. New SuggestionsView/keyedFeedRows added the external view. |

The source-specific content row is not a claim that Glass creates local summaries from a meeting feed: that remains prohibited by the approved no-SummaryService/no-local-history boundary. The upstream summary component and its Local behavior have not been deleted or changed.

## Clipping evidence and fix

Reproduction is from isolated Electron windows with synthetic state, not a fresh measurement of Said's running header. The real stack was not inspected or manipulated in this task.

- Existing initial native width is 353 DIP (windowManager.js). At Windows 175% scaling, the reproduction reports viewport **354**, Settings x **370.50** through **402.50**: entirely beyond the right edge. The Show/Hide shortcut area is partially clipped. See before-measurements.json and before.png.
- With the prior 445 request actually applied, the original phase-3 content fits (about 414.47 wide). Adding the selector alone does not exceed 445 with default shortcuts.
- A regression test proves windowManager dropped a header resize while another window animated: requesting 520 did not produce 520 before the fix. This could leave the initial/smaller size in place. The previous locked-window resize correction is also retained.
- MainHeader now measures intrinsic content, including shortcuts, Setup and conditional Done, and asks for that width. Children cannot shrink out of view. It checks the actual viewport rather than remembering a requested size.
- Main process no longer discards header measurements during unrelated animation and returns applied width/height. Setup transitions suspend the departing MainHeader's sizing so stale callbacks cannot compete.
- Final default-shortcut snapshot: header **461.96**, viewport **463**, Settings x **419.96** through **451.96**. Both sources and both capability profiles fit. Active/stopped states and larger shortcut combinations also pass.
- Welcome resizes to content height; permission Back gets additional layout space. Added controls must not clip earlier controls.

## File map

Changes for this regression:
- src/ui/app/MainHeader.js: measured sizing, resize observer cleanup, preserved Listen name, additive Done/Setup, Settings click/accessibility.
- src/ui/app/HeaderController.js: upstream setup routes, additive return routes, resize ownership during transitions, Welcome content sizing.
- src/ui/app/WelcomeHeader.js and ApiKeyHeader.js: separate source-return buttons; original actions retained.
- src/ui/app/PermissionHeader.js: restore Quit, separate Back and size allowance.
- src/ui/listen/ListenView.js: restore navigation, copy feedback, elapsed display for Meeting; simultaneous bounded panes retained.
- src/window/windowManager.js: acknowledged header resize; no animation-time drop.
- tests/header-controls.test.js and tests/helpers/header-controls.cjs: isolated native renderer/control matrix, Settings browsing and screenshots.
- tests/helpers/meeting-renderer.cjs: restoration, setup layout and resize ownership regressions; update cancellation tests to click the new separate Back buttons.
- tests/window-attachment.test.js: lost header resize and normal Settings visibility/hide cancellation tests.
- docs/wire2-header-checkpoint.md and wire2-header-evidence/: report and raw evidence.

Earlier resize/Phase 4 changes remain separately described in their existing checkpoints. Listener production code/tests, provider settings, capture, repositories, and Ask are unchanged by this regression fix.

## Verification

Final raw outputs are in wire2-header-evidence/:

| Check | Result |
| --- | --- |
| Glass Node 24.13.1 | 291 passed, 0 failed |
| Glass Node 20.20.2 | 291 passed, 0 failed |
| Listener Node 24.13.1 | 184 passed, 0 failed on final run |
| Listener Node 20.20.2 | 184 passed, 0 failed |
| Renderer build, Node 24 and 20 | Both successful |
| Focused renderer/window tests | 61 passed, 0 failed |

Glass TAP reports 1..260 top-level tests plus 31 subtests = 291 total. The earlier 1..239 / 255 similarly meant 239 top-level plus 16 subtests, not tests outside the plan.

Red evidence:
- regressions-red.tap: 55 total, 43 pass / 12 fail (failed parent tests included): clipped controls at initial width, missing Done, missing copy/navigation/elapsed, repurposed permission Quit, dropped resize.
- setup-red.tap: missing explicit route to Welcome.
- setup-layout-red.tap: newly added return control exceeded Welcome's fixed height; corrected before final checks.
- resize-ownership-red.tap: departing MainHeader could issue a conflicting resize during pending Setup transition; corrected.
- header-red.tap: initial 445px control geometry passed; Done/accessibility failures. This preserves the useful negative result that 445 itself was sufficient before the added restoration controls.
- transition-red.tap and transition-delayed-red.tap are passing exploratory transition checks; their filenames do not imply a reproduced failure.

One repeated Node 24 listener run failed with “fetch failed” in test/live-events-http.test.js:85 (unattached live route). Its output is retained in listener-node24-transient-failure.tap. Earlier runs passed, Node 20 passed, and the unchanged Node 24 suite passed when run alone. The underlying intermittent fetch failure was not diagnosed or fixed; no listener tests were altered.

Built-overlay check using the production renderer bundle and isolated native windows:
- 8 synthetic transcript rows; viewport/native height 623, intrinsic container 621.71, acknowledged last height 623.
- Transcript clientHeight 280, scrollHeight 556, bottom scrollTop 276; programmatic scroll moved to 200.
- Existing insecure-CSP warning and external-library load error occurred in this harness, which blocks all HTTP(S) requests. These are retained in built-overlay.txt; this is not an assertion of an error-free live console.
- Physical mouse-wheel scrolling and live bottom-follow remain unverified.

Screenshots: before.png / after.png show the reproduced header clipping and restoration. settings-meeting-only.png shows the unchanged Settings renderer with no providers and its normal scroll area. All use synthetic state, no transcript or credentials from the live meeting.

## Said's live re-check

After loading the rebuilt Glass at a time you choose:
1. In Meeting, confirm the three-dot control is visible at the right. Hover or click it; normal Settings should open.
2. Browse Settings and scroll to its lower controls. No LLM/STT setup is required just to browse.
3. Check Ask, Show/Hide and shortcuts remain present. Stop the meeting and confirm Done appears alongside Listen/restart.
4. Switch to Local after Stop; confirm the same header controls and Settings. Without providers, Listen should offer setup through the existing flow.
5. Check Setup → Welcome → personal API keys → Back; Quit remains distinct from the new return buttons.
6. Complete the still-open live overlay checks: correct window height, physical mouse-wheel scrolling to newer rows, and bottom-follow during live speech.

No live verification is claimed. No commits until the live matrix is accepted.
