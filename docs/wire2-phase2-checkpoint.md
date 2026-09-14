# Wire 2 Phase 2 checkpoint

Phase 2 implements the main-process meeting-feed subscriber and exposes unused IPC. No ListenView, SttView, header, provider, database, or renderer rendering changes are included. No Phase 3 work has started.

## Accepted Phase 1 commit

The exact requested local commit was created on `codex/wire2-phase1` after the staged-diff credential scan passed. No `logs/` file was staged. The temporary Node 20 executable remains ignored.

```text
1182c176495b9556ef6a3cb01b8168a41eb4c94f
[ADD] Wire 2 phase 1: live meeting feed — SSE /v1/live/events, typed subscriptions, bounded delivery (184 tests green Node 20+24)
28 files changed, 7262 insertions(+), 24 deletions(-)
```

The [actual hash, full git show --stat, and status output](wire2-phase2-evidence/phase1-git.txt) is retained verbatim. No attribution trailers or push. Raw Phase 1 failing-test evidence was committed as accepted, including its original whitespace.

Phase 2 is uncommitted in the Glass submodule on `codex/wire2-phase2`; its HEAD remains `703b775`. The parent remains at the Phase 1 commit and reports only ` M glass`. The committed listener source and tests have no diff against parent HEAD.

## File map and behavior

| File | Change |
| --- | --- |
| `src/features/listen/meeting/meetingFeedService.js` | Native HTTP SSE parser, validated state reducer, bounded history, private credentials, retry/liveness timers and cancellation |
| `src/features/listen/listenService.js` | Lazy construction, explicit start/stop/read methods, Listen-window state delivery and shutdown cleanup |
| `src/bridge/featureBridge.js` | Three explicit meeting-feed handlers; renderer arguments are ignored |
| `src/preload.js` | `window.api.meetingFeed` start/stop/getState/onState API, with listener-specific removal |
| `tests/meeting-feed-service.test.js` | 29 protocol, lifecycle, cleanup, credential and native HTTP tests |
| `tests/meeting-feed-ipc.test.js` | 5 tests loading the actual service/bridge/preload with capture/generation/database dependencies isolated |
| `tests/meeting-feed-integration.test.js` | Actual committed listener server and live session, fake Fireflies, two authenticated Glass subscribers on both loopbacks |
| `docs/meeting-feed-subscriber.md` | Configuration, IPC shape, reducer rules, timing and Phase 3 boundaries |

Snapshots replace transcript, retained history, instance, sequence and pending attempts atomically. Results upsert by instance and attempt ID with 20 retained outcomes. Same-instance duplicate sequences are ignored; gaps or unexpected identities force a new subscription. A server restart clears prior state on the new snapshot. Completed frames/comments sustain the 45-second deadline, while partial bytes do not. Backoff spans 500–1000 ms initially and 15000–30000 ms at the cap; only 30 seconds after a valid bootstrap resets retry count. HTTP 401 and `closed: true` stop automatic retries. Explicit Stop clears connection, timer and owned transport callbacks; late callbacks cannot change new state.

Only the main-process service reads `WRAPPER_TOKEN`, before its first connection. Credentials cannot enter through the IPC API, and never enter provider settings, renderer state, URLs or diagnostics. The subscriber imports only native HTTP and the UTF-8 decoder. No model provider, request queue, STT or generation dependency is used by the subscriber. Meeting controls do not create a local database session. Existing local Listen controls do not start the feed.

## Real test output

Runtime versions: Node `v20.20.2` and `v24.13.1`. All four complete runs exited 0, with no skips, cancellations or TODOs.

| Full suite | Node 20 | Node 24 |
| --- | --- | --- |
| Glass | [199 pass, 0 fail](wire2-phase2-evidence/glass-node20.tap) | [199 pass, 0 fail](wire2-phase2-evidence/glass-node24.tap) |
| Listener, unchanged | [184 pass, 0 fail](wire2-phase2-evidence/listener-node20.tap) | [184 pass, 0 fail](wire2-phase2-evidence/listener-node24.tap) |

Glass Node 20 output tail:

```text
1..199
# tests 199
# suites 0
# pass 199
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 6875.1661
```

Glass Node 24 output tail:

```text
1..199
# tests 199
# suites 0
# pass 199
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 7183.6105
```

Listener Node 20/24 tails report `# tests 184`, `# pass 184`, `# fail 0`, with durations 1854.8802 ms and 1726.0641 ms respectively. Full unabridged output is linked above.

Tests exercise byte fragmentation and split UTF-8, complete-frame liveness, snapshot replacement/reconnect deduplication, restart with a new instance, sequence-gap recovery, suggestion errors followed by a new attempt, explicit Stop during connection/backoff, terminal snapshots/status, listener ownership, late callbacks, bounded frames/history, credential reflection, and zero client capture/generation calls. The real integration also verifies one Fireflies connection and one generation loop across two subscribers and reconnects; automatic generation occurs only on an explicit server test tick.

Initial feature failures and subsequent passes are recorded in [subscriber-red.tap](wire2-phase2-evidence/subscriber-red.tap), [subscriber-green.tap](wire2-phase2-evidence/subscriber-green.tap), [ipc-red.tap](wire2-phase2-evidence/ipc-red.tap), and [ipc-green.tap](wire2-phase2-evidence/ipc-green.tap). The subscriber red artifact includes separate regression runs. Review identified pre-header EOF waiting until liveness and retained transport handlers; failing tests precede their fixes. [cleanup-red.tap](wire2-phase2-evidence/cleanup-red.tap) and [cleanup-green.tap](wire2-phase2-evidence/cleanup-green.tap) include the native response-listener regression. The full green matrix includes every final regression.

Independent review also reproduced a CR-only terminal frame remaining buffered until another byte arrived. [parser-cr-red.tap](wire2-phase2-evidence/parser-cr-red.tap) captures the failures, and [parser-cr-green.tap](wire2-phase2-evidence/parser-cr-green.tap) captures all 29 final subscriber tests passing. The parser now consumes CR immediately and swallows an optional following LF across fragments. The reviewer verified the fix with no further findings. Contract review found no remaining blocker and its requested running-attempt/error/retry test is included.

The [credential scan](wire2-phase2-evidence/secret-scan.txt) covers Phase 2 changes and evidence, checking configured credentials and key patterns without printing their values. The [final Git state](wire2-phase2-evidence/phase2-git.txt) records the unchanged parent/submodule HEADs and uncommitted Phase 2 files.

For a reproducible PowerShell Glass run, enumerate files explicitly for compatibility with Node 20:

```powershell
$glassTests = Get-ChildItem -LiteralPath tests -Filter '*.test.js' | ForEach-Object FullName
node --test --test-reporter=tap $glassTests
```

Run `node --test --test-reporter=tap` in `realtime_listener` for its unchanged full suite. The integration requires this parent checkout. Node 20 needed execution outside the filesystem sandbox to resolve the Windows parent directory; this did not change test content or credentials.

## Manual verification boundary

The automated integration uses real local sockets; no external Fireflies/model traffic or production credentials were used. Electron UI, packaging, and a real meeting have not been manually exercised in Phase 2. The renderer API is intentionally exposed but unused.

For later manual service verification, launch the existing server with its normal main-process configuration, launch Glass with matching main-process credentials, and inspect only the Listen window's `window.api.meetingFeed` API. Attach `onState` before `start`, verify state changes and retained history across a server restart, then call `stop` and the returned observer cleanup. Do not enter or print credentials in renderer tools. Regular Listen controls will still operate their existing local capture path; they do not select meeting mode yet.

## Phase 3 gate

Stop here for checkpoint review. Before meeting mode skips local session creation, inventory summary reset/persistence, Ask context/history/session linking, and every session-table/repository consumer. Decide source switching and local capture shutdown before connecting UI controls. Transcript/suggestion rendering, summary rendering validation, overlay sizing, and the provider-settings amnesia anomaly remain Phase 3 work.
