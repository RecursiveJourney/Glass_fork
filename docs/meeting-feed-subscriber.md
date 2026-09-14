# Meeting feed subscriber — Wire 2, Phase 2

This main-process service consumes the [Phase 1 feed contract](../../realtime_listener/docs/live-feed-contract.md). It does not capture audio, open Fireflies connections, invoke generation, use the Ollama request queue, or create a database session. The existing Listen UI does not call this service yet.

## Configuration and ownership

`src/features/listen/meeting/meetingFeedService.js` exports the CommonJS `MeetingFeedService` class. Production construction in `listenService.js` uses `http://localhost:11434/v1/live/events` and reads optional `process.env.WRAPPER_TOKEN` once at construction. Configure that environment in the main process before launching Glass; restart Glass after changing credentials. Do not enter the token in Glass provider settings or renderer tools.

The constructor also accepts a loopback URL and injected request/clock/timer/random implementations for testing. Only HTTP, the exact feed path, and `localhost`, `127.0.0.1`, or `::1` are accepted. URL credentials, query strings, fragments, and redirects are rejected or closed without following them. Production IPC accepts no URL or credential parameters. The token is private to the service, is sent only in the Authorization header, and is redacted if reflected in projected feed text. Unknown payload fields are discarded. Errors exposed to callers are fixed codes; transport errors and response bodies are never logged.

Each service owns one native HTTP request at a time. `start()` is idempotent during connection, connection recovery, and active delivery. `stop()` cancels the request and response, invalidates late callbacks, detaches owned transport handlers, and clears all timers. A harmless error sink remains on disposed emitters for late network errors. Subscription observers are independently removed with the function returned by `subscribe(listener)`; Listen removes its observer on Stop. Existing app shutdown reaches Stop through `listenService.closeSession()`.

## State and IPC

The synchronous main-process methods are `start()`, `stop()`, `getState()`, and `subscribe(listener)`. Subscription immediately delivers current state. Every delivery and read is an isolated copy. One failing observer cannot interrupt another observer or ingestion.

State has this shape:

```js
{
  connectionStatus: 'idle', // also connecting, connected, reconnecting, auth-required, closed, stopped
  snapshot: null,          // validated full feed projection once bootstrapped
  error: null,             // fixed code, never raw transport/server error text
  nextRetryAt: null        // wall-clock milliseconds when a retry is scheduled
}
```

The snapshot retains transcript data during transport interruptions and explicit Stop, with `connectionStatus` making that condition visible. A valid reconnect snapshot atomically replaces all transcript, history, identity, sequence, and pending-attempt state. A different instance therefore cannot inherit rows or attempts from the previous instance, even for the same meeting ID. Data arriving on a cancelled connection is ignored.

| Renderer API, exposed but unused | Main IPC | Result |
| --- | --- | --- |
| `window.api.meetingFeed.start()` | `meeting-feed:start` | `{ success, state }` or a fixed error |
| `window.api.meetingFeed.stop()` | `meeting-feed:stop` | `{ success, state }` or a fixed error |
| `window.api.meetingFeed.getState()` | `meeting-feed:get-state` | Current state |
| `window.api.meetingFeed.onState(callback)` | `meeting-feed:state` push | Returns a listener-specific cleanup function |

Pushes target the existing Listen window. The preload wrapper passes only state, never the Electron event. No renderer component subscribes yet. The API is separate from local Listen controls, STT events, and provider calls. It does not implement source switching or stop an independently running local Listen session; that lifecycle is a Phase 3 decision.

## Reducer and recovery

- The first domain event must be a full snapshot. UTF-8 bytes, CR/LF separators, comments, and multiline SSE data can arrive in arbitrary fragments. Incomplete frames are bounded at 1 MiB.
- Transcript snapshots replace the complete ordered window. The server owns correction order and eviction; the client does not expire rows by wall clock.
- Suggestions are complete outcomes upserted by `(instanceId, attemptId)` and retained to the declared limit of 20, including no-suggestion outcomes. Reconnect replaces history instead of appending it. This API publishes state, not arrival notifications; future cards must reconcile by those keys.
- Duplicate/older sequence numbers are ignored. Gaps, unexpected instance/meeting IDs, malformed payloads, and domain events before bootstrap cancel the connection and request a fresh snapshot. Sequence and transcript revision are independent. No Last-Event-ID is needed because the server always bootstraps authoritative state.
- Running attempts are restored from snapshots and reconciled with matching result/error events. Errors return the attempt to idle, expose `suggestion-failed`, and stay outside retained suggestion history. The server's free-form error message is not forwarded by this Phase 2 state API.
- Complete frames/comments reset a 45-second liveness deadline; partial bytes do not. The deadline also covers connection and response-header hangs. A comment heartbeat does not mark an unbootstrapped connection as connected.
- Network failure, EOF, HTTP 503, and protocol recovery use uniform jitter from half-cap to cap, where `cap = min(30000, 1000 * 2^n)` milliseconds. Initial delay is 500–1000 ms; maximum delay is 15000–30000 ms. Retry count resets only after 30 seconds following a valid bootstrap on the same healthy connection. Server-provided SSE retry fields do not override this policy.
- HTTP 401 enters `auth-required` with no automatic retry. Terminal `closed: true` applies the final snapshot/status and stops retries. An explicit Start can begin another subscription. Explicit Stop cancels even a pending retry.

## Verification and remaining work

Run the full Glass tests from this checkout on Node 20 and 24. `tests/meeting-feed-service.test.js` uses deterministic transport/timer fakes plus native local HTTP; `tests/meeting-feed-ipc.test.js` loads the actual bridge/preload/Listen modules with capture, generation, and database dependencies replaced by assertions/stubs. `tests/meeting-feed-integration.test.js` imports the sibling committed `realtime_listener` modules and runs the actual server/live-session feed with fake Fireflies and a counted suggestion adapter. The integration test therefore requires the parent Digital Twin checkout.

The checkpoint contains raw TAP evidence. These tests do not contact Fireflies or a model. Electron UI rendering, real meeting credentials, packaging, summary rendering, and overlay sizing are not exercised in this phase.

After Phase 3 approval, inventory consumers of a local database session ID before implementing source switching: summary reset/persistence, Ask context/history/session linking, and session-table/repository readers. Provider-settings amnesia investigation, transcript/suggestion rendering, overlay sizing, and local capture behavior belong to that later checkpoint.
