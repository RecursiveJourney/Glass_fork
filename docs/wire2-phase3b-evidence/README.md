# Step 3b evidence

The authoritative final runs are `glass-node20.tap`, `glass-node24.tap` (255 passing each), `listener-node20.tap`, `listener-node24.tap` (184 passing each), and the two `build-node*.txt` files. All tests completed without failures or skips. `meeting-overlay.png` is synthetic content captured from the actual isolated Electron renderer and inspected visually.

The renderer harness uses actual source components in Chromium, mocked IPC and a temporary isolated Electron profile. External requests are blocked. Capture and main-service tests use fake devices/providers/repositories; they do not activate hardware or contact Fireflies. The installed Electron runtime is the same for both Node test hosts.

| Evidence | Regression demonstrated |
|---|---|
| `renderer-red.tap` | Missing Phase 3 render/hydration/selector behavior before implementation |
| `renderer-integration-red.tap` | Stopped state cannot restart; selector inherits native drag region; full-height host masks intrinsic layout size |
| `setup-return-red.tap` | Separate credential and permission setup cancellation traps |
| `hydration-mount-red.tap` | Local SummaryView mounts before authoritative source is known |
| `cleanup-action-red.tap` | Failed local cleanup has no Stop retry action |
| `capture-cleanup-red.tap` | One failing disconnect prevents remaining capture cleanup |
| `linux-capture-red.tap` | Linux microphone and AudioContext are not owned by Stop |
| `capture-retry-red.tap` | Failed release is discarded, so a later Stop falsely reports success |
| `lifecycle/*-red.tap` | Main/STT/summary initialization, callback, acknowledgement, ownership and persistence hazards; details in its README |
| Final Glass TAP files | All renderer/capture/core regressions pass together with the pre-existing suites |

`capture-red.tap` preserves an early test-development run; its fourth test failed on an incomplete timer stub. The corrected test produced the meaningful failure in `capture-cleanup-red.tap` before the fix. Core lifecycle notes similarly distinguish initial harness mistakes from corrected baseline reproduction. Earlier `*-initial.tap`, focused and intermediate green files are chronological evidence, not the final count. No test-harness error is presented as a product defect.

`verify-checkpoint.cjs` reads added diff lines and new text artifacts, scans for known environment/.env credential values and common token/private-key patterns, and checks protected production paths, listener source, staged state and diff whitespace. It prints only pass/fail and counts; matching contents are never printed. `verification.txt` records its result. This is a scoped secret check, not a claim of exhaustive detection of every possible secret format.
