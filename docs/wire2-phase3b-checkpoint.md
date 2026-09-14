# Wire 2 Step 3b checkpoint

Implemented the approved overlay and lifecycle with the revised Ask ruling. No commits, no push, no Phase 4 work. Glass remains on `codex/wire2-phase2` at `30f7362eb7f8b3ca3ab4ccad8abfc60d9d060f1d`; the parent remains on `codex/wire2-phase1` at `1182c176495b9556ef6a3cb01b8168a41eb4c94f`. The parent gitlink is not staged.

## Delivered behavior

- MainHeader exposes Local/Meeting selection, driven by main-process source/phase/version. Configured users default Local; meeting-only users default Meeting. Selection locks during transitions/activity and uncertain local cleanup. Stop retains the last meeting view; the next Listen starts a fresh subscription. Failed local cleanup exposes Stop retry.
- Meeting-only users reach MainHeader without LLM/STT setup or capture permissions. Local's explicit setup action retains the existing provider and permission requirements, including keychain setup. Both setup screens can return to source selection. Auth reevaluation and forced provider-setup notifications do not eject a meeting-capable user.
- Transcript and suggestions remain visible together. Transcript rows use `(transcriptId, chunk_id)` and reset on instance changes; suggestion rows use `(instanceId, attemptId)`. Speaker labels and suggestions use `textContent`, with no payload HTML insertion. Full snapshots apply together; old hydration cannot overwrite newer state. Local SummaryView is not mounted while source hydration is pending or Meeting is rendered.
- Transcript and suggestion panes have bounded independent scroll regions. Corrections preserve the visible row anchor; readers at the bottom follow additions. Resize requests depend on actual dimension changes, with intrinsic meeting height independent of the previous Electron window height.
- Meeting Start/Stop uses only the existing main-process subscriber. Feed IDs never enter repositories. Meeting outages retain the selected source and visible connection status; there is no local fallback or provider/model mutation. Credentials remain in the Phase 2 main-process configuration.
- Local initialization must remain current through STT initialization and capture acknowledgement before becoming active. Stop invalidates callbacks immediately, waits for capture release acknowledgement, clears SummaryService identity, and attempts all owned cleanup steps. Failed sockets, capture operations and session-end operations remain owned for retry. Summary completion checks its dispatch identity after generation and persistence awaits.
- Ask production code, shortcuts, repository implementations and provider paths are unchanged. Ask remains usable during Meeting, including screenshot, independent Ask-session persistence, streaming and screen-only shortcut. A pending Ask proceeds through Meeting Stop and source switches. No meeting path calls Ask or injects feed rows into local history/SummaryService. SQLite and Firebase tests pin promotion to an explicit Listen request; an Ask request only touches or creates an Ask row.

## File map

| Area | Files |
|---|---|
| Main lifecycle and capture acknowledgement | `src/features/listen/listenService.js` |
| STT callback/socket ownership and native process exit | `src/features/listen/stt/sttService.js` |
| Summary dispatch identity and cleanup | `src/features/listen/summary/summaryService.js` |
| Authoritative IPC and sender validation routing | `src/bridge/featureBridge.js`, `src/preload.js` |
| Source selection and capability/setup entry | `src/ui/app/MainHeader.js`, `HeaderController.js`, `PermissionHeader.js` |
| Atomic hydration and bounded simultaneous layout | `src/ui/listen/ListenView.js` |
| Transcript keys, labels and suggestion rendering | `src/ui/listen/stt/SttView.js`, `src/ui/listen/meeting/SuggestionsView.js`, `keyedFeedRows.js` |
| Capture command serialization and complete release | `src/ui/listen/audioCore/renderer.js`, `listenCapture.js` |
| New tests | `tests/meeting-lifecycle.test.js`, `summary-lifecycle.test.js`, `meeting-capture.test.js`, `meeting-ask.test.js`, `meeting-renderer.test.js`, `tests/helpers/meeting-*` |
| Updated integration harnesses | `tests/meeting-feed-ipc.test.js`, `tests/system-audio-ipc.test.js` |

`listen:state` carries `{source, phase, lifecycleId, version, error, feed}` to header and listen windows. `listen:get-state`, `listen:get-capabilities`, `listen:select-source` and `listen:capture-ack` are exposed through preload. Capture commands use a five-second acknowledgement deadline and validate the actual Listen webContents plus lifecycle identity. The legacy meeting-feed start/stop IPC now routes through the authoritative lifecycle and rejects a Local source. Ask IPC routing is unchanged.

## Actual verification

| Suite | Node 20.20.2 | Node 24.13.1 |
|---|---:|---:|
| Complete Glass suite | **255 passed, 0 failed, 0 skipped** | **255 passed, 0 failed, 0 skipped** |
| Unchanged listener suite | **184 passed, 0 failed, 0 skipped** | **184 passed, 0 failed, 0 skipped** |
| Renderer build (`build.js`) | Passed | Passed |

Raw output: [Glass Node 20](wire2-phase3b-evidence/glass-node20.tap), [Glass Node 24](wire2-phase3b-evidence/glass-node24.tap), [listener Node 20](wire2-phase3b-evidence/listener-node20.tap), [listener Node 24](wire2-phase3b-evidence/listener-node24.tap), [build Node 20](wire2-phase3b-evidence/build-node20.txt), [build Node 24](wire2-phase3b-evidence/build-node24.txt).

Final Glass TAP totals on each runtime:

```text
1..239
# tests 255
# suites 0
# pass 255
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

Final listener TAP totals on each runtime:

```text
1..184
# tests 184
# suites 0
# pass 184
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

Commands: `node --test --test-reporter=tap tests/*.test.js` in Glass and `node --test --test-reporter=tap` in listener. Node 20 uses the existing ignored `realtime_listener/logs/node20.exe`; PowerShell enumerates `tests/*.test.js` into an argument array because Node 20 does not expand this glob. Renderer tests launch the installed Electron in an isolated temporary profile, hidden window and loopback fixture with external requests blocked. Both Node hosts execute the same installed Electron renderer; this is not a claim that Electron embeds both Node versions. Windows parent-directory access and Electron launch required sandbox escalation. A sandbox-restricted esbuild attempt failed; both subsequent authorized builds passed.

The existing listener source/tests remain untouched. The Phase 2 subscriber tests still cover fragmented SSE/split UTF-8, reconnect, instance restart, sequence gaps, liveness/backoff, cancellation, cleanup and credential isolation. Added tests cover actual DOM rendering, native no-drag control styling, hydration, scroll anchoring, setup return, lifecycle/capture acknowledgement, failed cleanup retry, late callbacks/completions and Ask independence. Spec and integration reviews identified concrete hazards, which were reproduced and fixed before final runs.

## Red-to-green record

See [evidence notes](wire2-phase3b-evidence/README.md) and [core lifecycle notes](wire2-phase3b-evidence/lifecycle/README.md). Retained red runs demonstrate failed initialization starting capture, stale callbacks/completions, premature cleanup success, retired sockets, failed renewal identity, lost DB-end retries, Linux resource leaks, cleanup retry loss, blocked UI restart, native selector drag region, inherited full-window height, setup-return traps, premature summary mounting and missing cleanup retry action. Final green suites contain these regressions. No-promotion is an existing-behavior pin, not a claimed repository defect.

Secret/scope verification is recorded in [verification.txt](wire2-phase3b-evidence/verification.txt), with its read-only scanner included alongside the result. No known environment/.env credentials or token/key patterns were found in added diff lines or new text artifacts. Synthetic screenshot content was inspected visually. Ask/repository/provider/shortcut/listener source remained unchanged; index empty; diff whitespace check clean.

## Visual/manual boundary and review steps

[Inspected synthetic Electron preview](wire2-phase3b-evidence/meeting-overlay.png): both panes are visible, speaker labels distinct, suggestions readable, Ask present, and source locked during activity. Actual Chromium layout checks additionally cover long feeds, corrections and scrolling.

No real Fireflies meeting, physical microphone/system loopback, macOS native binary or authenticated live Ask request was exercised. Provider-backed local summary rendering remains a live verification item; the new meeting view bypasses it, while identity/persistence tests cover summary cleanup. The renderer fixture mocks IPC; main lifecycle tests execute actual services with synthetic transports/repositories. Live end-to-end verification remains for the next approved checkpoint.

After checkpoint approval, manual verification should cover:

1. Launch the existing server and Glass with credentials configured only in main. Choose Meeting, start, and confirm transcript corrections plus completed suggestions appear without terminal use, capture activation or a meeting DB row.
2. Ask during the call using the header and screen-only shortcut. Confirm the independent Ask record/response and server-attached Fireflies context; Meeting must not copy feed rows to local history.
3. Disconnect/restart the server. Confirm visible reconnect status, retained view, snapshot replacement on new instance, no duplicate attempts and no provider-setting/model changes. Test terminal close and explicit Stop/restart.
4. With Local configured, Start/Stop, verify microphone/system capture release, then switch to Meeting. Exercise failed capture cleanup and its Stop retry. Verify late local callbacks cannot appear in Meeting.
5. With no providers/permissions configured, confirm Meeting is reachable; enter and cancel both Local setup detours; reevaluate auth and force provider setup without losing Meeting access.
6. On supported displays/OSs, test a long feed, scroll mid-transcript, corrections/eviction, window movement and repeated status events. Confirm both panes stay accessible and dimensions do not oscillate.

Stopped here for checkpoint review. No Phase 4 actions or further commits are authorized by this report.
