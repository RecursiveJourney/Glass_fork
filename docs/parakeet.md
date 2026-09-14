# Parakeet experiment — DT-13 parked

Round5 failed the final settled-text retention checkpoint. The experimental pure modules and benchmark evidence remain uncommitted for review. Parakeet is not a selectable Glass provider; no model service, utility worker, installer, renderer wiring or Settings path has been added. Whisper Tiny remains the existing fallback.

## Adopted revisable contract

Commit-once is retired. Decode hypotheses appear immediately as source-timed spans with `provisional: true`. Upserts replace prior revisions and can atomically remove superseded split/merged spans. While source audio is younger than25 seconds, spans remain revisable. At expiry they finalize as the best known hypothesis, preferring greatest distance from either decode edge, then fuller context. Flush/stop finalizes all remaining spans. Future UI integration must visibly distinguish provisional/final text, for example grey/italic provisional text. That rendering is not implemented.

The experimental planner requests3 seconds of new audio with up to16.5 seconds preceding context under a19.5-second input cap. PCM retention is25 seconds. Finalized text anchors are retained an additional25 seconds to prevent timestamp-drift reopening; this is not additional audio retention. No separate confirmation/diversity decodes run in Round5. Each channel must own independent planner/stitcher state when/if integrated.

## Evidence and limitations

Parent-repo evidence: `bench/dt13/bounded-emission-r5/report.md`, `diffs.md`, `evaluation.jsonl`, `summary.json`. Seven of11 cases pass the requested loss gate. Continuous and all three forced-continuous offsets still lose2–3 ungated-correct words. Maximum decode RTF is0.36723; pooled first provisional span latency has median2.570s and p954.314s, with a20.519s maximum from a late duplicate hypothesis. This is offline source-clock replay, not a live-renderer/two-channel measurement.

Bounded live decoding changes recognition and can retain substitutions/insertions despite larger context. Examples include parts→parties, quantity→quality, duplicate Our, and remaining10 two. A loss-only gate does not certify insertion-free numeric fidelity. Zero newly lost negations/numeric values was observed; the corpus contains no currency audio. Existing model-level tier/two errors remain excluded from additional-loss counts.

The protocol accepts validated `spanUpdate` replies at16kHz and supports atomic replacements, explicit provisional/final flags and monotonically increasing per-span revisions. The future worker/consumer must enforce ordered session sequence and generation handling; these pure helpers do not provide an actual IPC lifecycle. No further integration is authorized after the failed checkpoint. Wire1/DT-15 await a separate instruction.
