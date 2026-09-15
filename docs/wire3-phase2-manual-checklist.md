# Wire 3 Phase 2: Settings observations and Setup

Automated native checks are recorded in the parent `docs/wire3-phase2-evidence/`. This checklist is for a real installed/development session; it is not a claim that the operator checks below have run.

Use the existing Phase 1 runtime-managed launch configuration and its dedicated control token. Do not display keys, tokens, dossier text or transcript content in evidence. These checks need no additional Fireflies invitation: reuse an already connected meeting and do not save a new meeting link.

1. Open Settings. Existing provider controls, Ollama/Whisper labels, Personalize, shortcuts and application controls remain. Digital Twin component rows, Knowledge and Setup appear below the provider area. The fork Setup button is absent from the header; upstream header controls remain.
2. With the twin running, Digital Twin server becomes Reachable after polling (two seconds between completed reads). Before a real Gemini request, Gemini says Not tested. A completed Ask/automatic request changes the last observed result and time. A stored key alone must not produce a ready/success claim.
3. In Meeting source, Transcription identifies Fireflies and shows the stream state separately from Listen phase. Stopping the Glass view does not claim that the server-owned Fireflies connection stopped. In Local source, start an already configured provider; verify its actual provider/model and Session loaded. Stop and verify No local STT loaded. This row does not promise ongoing network health of a local cloud STT session.
4. Knowledge shows the loaded dossier basename/hash and wire-1 prompt version/assembled hash, with no editable input, full path or text. Editing the dossier file while the listener runs must not change these values; restarting the listener with that dossier reloads them.
5. Stop the twin process. The server/Gemini/Fireflies rows become unavailable; last good Knowledge becomes explicitly cached/stale. Restart with the same launch configuration; current metadata replaces the stale display. Wrong/missing control authentication must never report Reachable. Avoid recording credentials while testing this condition.
6. Stop Listen, then press Setup in Settings. Settings closes and the existing Welcome/setup flow opens, retaining login, permission, Quit and return controls. Return to the header. While Listen is starting/active/stopping, Setup is disabled; main also rejects a stale click after the phase changes.

Report pass/fail plus state names and observation times only. No extra model call is made by polling. Any optional real Ask uses the normal model request budget. Invitation consumption for this checklist is zero if the existing meeting is reused.

## Accepted operator result

The operator reported PASS for status changes across server kill/restart, Setup opening, correct Knowledge and preserved upstream UI; Phase 2 UI checks were then fully accepted. The first two greeting Asks reached the listener and generated the frozen prompt's expected `[no suggestion]` result. The apparent empty presentation is accepted as pre-existing behavior, with a friendly Glass-only empty-state queued for a later phase and no prompt change. See the parent `docs/wire3-phase2-ask-anomaly.md` for the metadata-only timeline and accepted classification. This acceptance does not claim extra invitations or unreported audio-provider checks.
