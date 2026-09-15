# Wire 3 Phase 1 — live acceptance

Status: Said reported all seven live checks passed and accepted Phase 1. The implementation checkpoint and live gate are accepted; the local commit/merge sequence is authorized, with no pushes. Automated fixtures sent zero Fireflies invitations.

## Accepted live result

These results are Said's reported observations from the live run, not automated-test claims. No transcript text, meeting identifiers or credentials are recorded here.

| Check                   | Accepted observation                              |
| ----------------------- | ------------------------------------------------- |
| Overlay transcript      | Live transcript appeared with real speaker names  |
| No-op re-save           | Zero additional invitations                       |
| Glass restart/reconcile | Reconnected with zero additional invitations      |
| Meeting switch          | Invitation number 2; old content cleanly replaced |
| Ask                     | Answered using live meeting content               |
| Clear key               | Unconfigured state; no self-reconnect             |
| Re-enter key            | Reconnected with zero additional invitations      |

Expected behavior accepted during the run: the Fireflies bot remains in the previous meeting after a switch. The current Fireflies integration has no recall operation; switching isolates the selected feed and does not remove the old bot. Feed isolation held during the live check. Automatic bot removal is a future nicety, subject to a supported removal mechanism.

Deferred cosmetic fix: `meeting.selected` currently logs `source: "argument"` for meetings applied through runtime configuration. The meeting selection works; the provenance label should identify runtime configuration in a later change. No production change is included for this follow-up.

The seven checks above close the live gate as accepted by Said. The broader preparation/budget instructions below remain a reusable run sheet; acceptance does not claim every optional uncertainty/rate-limit scenario below was separately run live.

## Preparation

- Run the listener in the approved runtime mode and Glass with the same independently generated `TWIN_CONTROL_TOKEN` supplied privately through their launching environment. Keep `WRAPPER_TOKEN` as the separate optional feed/chat token. Do not put tokens in commands, screenshots, messages or URLs.
- Use the same explicit runtime state directory across listener restarts. Never discard its ledger to make a rate-limit test pass.
- Enter the Fireflies key only in the Glass password field. A blank field keeps it; Clear is explicit. Start with a known invitation budget and account activity. Requests from other clients also count against Fireflies' external limit.
- Record metadata only: saved/applied revisions, operation states, measured durations, invitation count, pass/fail and fixed error codes.

## Invitation budget and case order

Maximum three new invitations in any rolling twenty-minute window. Stop the invitation cases when the budget is exhausted; never spend an extra invitation to compensate for a failed assertion.

| Case     | Action                                                                                                                             | Maximum new invitations |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------: |
| A        | Save key and Meet link A; admit the bot and verify the selected meeting                                                            |                       1 |
| A1       | Repeat Save, double-click Save, submit with Enter                                                                                  |                       0 |
| A2       | Replace the key for the same meeting; test unavailable/invalid credential, then restore privately                                  |                       0 |
| A3       | Restart Glass; restart the listener using its retained state directory                                                             |                       0 |
| B        | Change to link B with Ask/automatic work outstanding; admit and verify only B's material reaches the next Listen/Ask               |                       1 |
| C        | Exercise an uncertain join result with the remaining slot; preserve its reservation and confirm polling never repeats the mutation |                       1 |
| C1       | Attempt another explicit Join again while exhausted; verify a rate-limit state and zero transport mutation                         |                       0 |
| Recovery | After the full cooldown, choose a new explicit retry intent if needed; run this in a later budget window                           |       1 in later window |

If a matching active meeting already exists, discovery selects it and consumes no invitation. A paused or ambiguous match must not cause a blind invitation. Key rotation must never invite, even after a server restart or lost acknowledgement.

## Acceptance checks

- Save reports Applied for the new revision in less than one second under normal local conditions. Joining/authentication is a separate state and may take longer. Saved-pending must be shown when the server is unavailable.
- Next Meeting Listen uses the latest applied revision. Stop while configuration is pending prevents a late start. Local Listen ownership and source-lock behavior remain intact.
- Switching clears old transcript/suggestion material immediately. Old Ask leases, old feed close events and obsolete callbacks do not populate the new meeting.
- Clear disables Fireflies and does not fall back to an old environment key. Restart retains the cleared state.
- Stored provider/Fireflies keys are never prefilled. Replacement fields clear after success and failure; responses/broadcasts/logs contain no keys, fragments or key fingerprints.
- Restart restores provider choices, including offline selections. Locked/migration-required credentials produce a recovery state, never silent reset.
- Existing provider controls, Personalize and Setup remain present. Personalize is untouched; Setup relocation belongs to Phase 2.

Retain every failed case and its original redacted evidence. Return the case matrix and the actual invitation ledger count to the task before accepting the live gate. Signing and uninstall retention remain Phase 5 questions for Ryan.
