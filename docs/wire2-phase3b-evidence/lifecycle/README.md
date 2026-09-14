# Lifecycle evidence

- `red.tap` preserves the first failing run before implementation. Despite its extension, that first run used Node's spec reporter. It reproduces capture starting after failed initialization, late initialization after Stop, and both summary identity failures. The initial delayed-transcription assertion returned before its callback finished and was subsequently corrected to await the real handler.
- `baseline-replay-red.tap` runs the corrected current regression tests against the three original `HEAD` source files in an isolated temporary directory. All six selected original hazards fail: failed initialization capture, late initialization capture, delayed transcription persistence, stale STT rendering after restart, summary reset identity, and stale summary persistence/rendering. This is a later baseline replay, not the initial chronological red run.
- The other `*-red.tap` files record focused failures immediately before their fixes: STT identity, cleanup continuation, capabilities, retries, capture readiness, process exit, and complete resource ownership.
- `green.tap` runs the lifecycle, summary, and existing STT model-selection suites together. `summary-green.tap` isolates the summary checks.

The tests isolate Electron windows, provider I/O, and persistence with synthetic data. Capture acknowledgement tests verify actual renderer sender identity, lifecycle matching, and the five-second timeout without real capture. They do not replace live renderer verification.
