# Wire 2 Step 3b execution plan

The approved Step 3a inventory is revised by the user's ruling: Ask stays fully independent and unchanged in both sources, including persistence, screenshot and shortcut. Meeting transitions never call, abort, settle, gate or wait on Ask. The ephemeral Ask alternative is dropped. The no-session rule applies to the meeting lifecycle only.

- [x] Main lifecycle: authoritative source/phase/version; successful-current-local initialization; acknowledged capture shutdown; local callback identities; independent meeting subscriber cleanup. Red regressions before correcting local hazards.
- [x] Summary lifecycle: clear session ID on local cleanup, capture identity at dispatch, reject stale completion after awaits before storage/state/publication.
- [x] UI and IPC: non-secret per-action capabilities; Local/Meeting selector; meeting-only header eligibility; atomic hydration with obsolete-response rejection; capture acknowledgements.
- [x] Meeting view: keyed transcript rows with speaker labels; complete suggestions as escaped plain text; stacked bounded scroll areas; preserve scroll and resize only for changed dimensions.
- [x] Ask proof: actual request entry remains independent in Meeting; SQLite and Firebase getOrCreateActive('ask') do not promote existing Ask rows to Listen. No Ask production changes.
- [x] Verification: renderer browser tests, focused red/green evidence, spec and quality reviews, complete Glass and unchanged listener Node 20/24 suites, rendered preview and checkpoint. No commits or Phase 4 work.

Main/renderer contract: `listen:state` carries `{source, phase, lifecycleId, version, error, feed}`; `phase` is idle/starting/active/stopping/stopped, version monotonically increases. `listen:get-state`, `listen:get-capabilities`, `listen:select-source` expose current state/capabilities and selection. Capture commands carry `{status, lifecycleId}` and `listen:capture-ack` returns `{status, lifecycleId, success}` from the actual Listen webContents. No credentials are in these messages.

Expected files: ListenService, SummaryService, STT callback ownership if needed, featureBridge/preload, capture renderer/cleanup, MainHeader/HeaderController, ListenView/SttView and new SuggestionsView. Keep Ask, repositories, provider settings and listener source unchanged. Tests assert those boundaries.
