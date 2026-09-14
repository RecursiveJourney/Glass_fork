# Wire 2 Phase 4 automated checkpoint

The authorized Phase 3 commit is complete. Phase 4 automated verification is complete; the six live checks remain pending Said's run and review. No Phase 4 commit or push was made.

## Phase 3 commit and TAP clarification

Glass branch: `codex/wire2-phase2`. Local commit: `a7394e4ce177f8356f16d65e88b2ea366c3611f5`.

```text
[ADD] Wire 2 phase 3: Local/Meeting source selection, meeting overlay with live transcript and suggestions, guarded lifecycle (255 tests green Node 20+24)
65 files changed, 10710 insertions(+), 398 deletions(-)
```

The staged Phase 3 diff passed the credential/key-pattern scan before committing. The exact requested message has no attribution trailers. [Real git show --stat output](wire2-phase4-evidence/phase3-commit-stat.txt) contains the complete file map. Parent HEAD remains `1182c176495b9556ef6a3cb01b8168a41eb4c94f`; the updated Glass gitlink is not staged.

The accepted Phase 3 TAP output has **239 top-level results plus 16 nested renderer results = 255 tests** on each runtime. Every result belongs to its corresponding TAP plan; these are not tests outside the plan. See the [plan audit](wire2-phase4-evidence/phase3-plan-audit.txt). Phase 4 adds seven top-level tests, so its Glass plan is `1..246` with total 262.

## Phase 4 file map

| File | Change |
| --- | --- |
| `tests/window-attachment.test.js` | Seven meeting-layout cases using the existing window manager/movement harness and real ListenView state/resize methods. |
| `docs/meeting-feed-subscriber.md` | Updated the historical subscriber-only description to the completed lifecycle and overlay contract. |
| `../realtime_listener/README.md` | Final startup/workflow, ownership, protocol summary and manual verification links. |
| `../realtime_listener/docs/live-feed-contract.md` | Final Glass subscription/lifecycle contract, Ask independence, layout and outstanding manual acceptance. |
| `../realtime_listener/docs/design.md` | Final server/main/renderer ownership map and verification boundary. |
| `../realtime_listener/docs/wire2-manual-checklist.md` | Exact PowerShell startup commands, clicks, expected results and safe evidence for all six live checks. |
| This checkpoint and `wire2-phase4-evidence/` | Real test/build/git output and read-only scope/secret verifier. |

The new window cases cover: 445×47 header attachment; 100 equal-dimension stream/status updates without repeated resizing; ceiling/cap behavior; repeated above/below and destination-monitor moves with both zero and two-DIP rounding; independent Ask sizing beside Meeting; retained Stop layout and local-content remeasurement. Existing 13 window tests remain; the focused file now passes 20 tests.

This is additive integration coverage, with no new production defect or fix claimed. Its measured 600px fixture and native rounding simulation are synthetic. It does not prove actual desktop scaling, device capture, live Fireflies behavior or physical window placement. Existing Electron renderer tests also run in the full Glass suite. The live matrix explicitly retains these physical checks.

## Actual verification

Runtime versions: Node **20.20.2** and **24.13.1**. Tests use synthetic data/transports; no live Fireflies/Gemini call was started for this checkpoint.

| Check | Node 20 | Node 24 |
| --- | --- | --- |
| Full Glass suite | [262 passed, 0 failed](wire2-phase4-evidence/glass-node20.tap) | [262 passed, 0 failed](wire2-phase4-evidence/glass-node24.tap) |
| Full unchanged listener suite | [184 passed, 0 failed](wire2-phase4-evidence/listener-node20.tap) | [184 passed, 0 failed](wire2-phase4-evidence/listener-node24.tap) |
| Renderer build | [Exit 0](wire2-phase4-evidence/renderer-build-node20.txt) | [Exit 0](wire2-phase4-evidence/renderer-build-node24.txt) |

The first Node 24 listener run had **183 passed / 1 failed**: the OpenAI role-filtering HTTP test failed in `fetch` before its assertions. [Original failure output](wire2-phase4-evidence/listener-node24-initial-failure.tap) is retained. The unchanged HTTP file then passed [35/35](wire2-phase4-evidence/listener-node24-http-recheck.tap), and the complete unchanged suite passed 184/184. The failure did not reproduce; its underlying cause remains unconfirmed. No listener code/test change or assertion weakening was made, and this is not reported as a fixed defect.

Commands used from `glass` (the ignored Node 20 runtime is outside the staged work):

```powershell
node --test --test-reporter=tap tests/*.test.js
$glassTests = Get-ChildItem -LiteralPath tests -Filter '*.test.js' | ForEach-Object FullName
& '../realtime_listener/logs/node20.exe' --test --test-reporter=tap $glassTests
node build.js
& '../realtime_listener/logs/node20.exe' build.js
```

From `realtime_listener`:

```powershell
node --test --test-reporter=tap
& './logs/node20.exe' --test --test-reporter=tap
```

Node 20 receives expanded test paths because it does not expand the Glass wildcard. The actual output files above were captured with shell redirection and exit codes checked. Both suites report zero cancelled, skipped or todo tests. [Focused window output](wire2-phase4-evidence/window-focused.tap) is also retained.

The manual guide's eight PowerShell blocks and four embedded JavaScript blocks passed [syntax checks](wire2-phase4-evidence/manual-command-syntax.txt); those checks did not execute the live commands. Read-only reviews checked the window fixtures and manual commands against source. The test launcher's application-path difference and platform-specific permission limitations are documented.

The [final verifier](wire2-phase4-evidence/verify-checkpoint.cjs) scans added diff lines and new text files for configured environment/.env credential values and common key patterns without printing matches. It checks the approved file scope, empty staging areas, expected HEADs and whitespace. See [verification output](wire2-phase4-evidence/final-verification.txt) and [real status for both repositories](wire2-phase4-evidence/git-status-both.txt). All production source, Ask, providers/settings, repositories, local capture and listener tests are unchanged in Phase 4.

## Manual checkpoint — stop here

Said should follow the [plain step-by-step manual checklist](../../realtime_listener/docs/wire2-manual-checklist.md). It provides hidden credential prompts, exact server/Glass commands, expected overlay behavior and a return matrix for:

1. Live transcript/corrections, complete suggestions, Stop/reconnect and absence of meeting persistence.
2. Independent Ask request/shortcut/persistence during Meeting, including source transitions during an Ask request.
3. Outage/restart/dedupe/cancellation and deterministic synthetic terminal closure; provider selections remain unchanged.
4. Local capture, acknowledged cleanup, return to Meeting and absence of local leakage.
5. Fresh meeting-only access and setup/auth notification reevaluation.
6. Long-feed scroll preservation, bounded panes, native attachment/display scaling and Ask coexistence.

No live result is claimed. Local summary formatting, provider-settings amnesia/model discovery, physical capture cleanup and real monitor behavior remain explicit manual observations. Paste only the guide's safe status/count reports and completed matrix. Missing observations must be marked BLOCKED, NOT OBSERVED or platform-specific N/A. Phase 4 remains uncommitted pending that review.
