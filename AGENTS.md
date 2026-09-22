# Repository instructions for coding agents

The live training data path is a protected, field-tested core. Before changing serial capture, WebSocket ingest, IndexedDB outbox, SQLite samples, flight-state classification, strip/timeline rendering, or recovery, read `docs/LIVE_DATA_PIPELINE.md` in full. Prefer adding new features as read-only consumers of the existing authoritative results.

Do not change core behavior as incidental cleanup, deduplication, performance tuning, or UI work. In particular, preserve:

- Worker-owned serial reading and JSON framing; receiver-hub monotonic capture time for buffered frames; current sticks never fast-play historical frames.
- One approximately 30 Hz latest-frame live stream, with approximately 5 Hz durable frames selected from it. Write each durable frame to IndexedDB before sending; only successful server processing/ACK permits deletion. Never compact or positively ACK an unprocessed durable frame.
- Explicit `backfill: true` as the sole recovery-lane identifier. Online delay, hidden-tab scheduling, clock skew, and server load are not evidence of backfill. Current live frames have priority over old recovery packets.
- SQLite as the history authority. Backfill uses original capture time and historical receiver assignment, never mutates current live-state windows or broadcasts old sticks, and ends with a new authoritative baseline. Genuine sample gaps over one second stay visible.
- Server-owned flight rule: `armed && throttle spread in the preceding 5 seconds > 80`, using bounded raw throttle extrema from the sampled window. Never replace it with frontend decisions, state hold, absolute throttle, or visual gap filling.
- Fast, incremental recovery without starving current live data. Do not casually lengthen the outbox drain, server drain, or progressive publish intervals.

If the user explicitly requests a core change, make the smallest evidence-backed change, state the contract being changed, add a regression test for the failure, run the relevant checks in `docs/LIVE_DATA_PIPELINE.md`, and report what a real browser/receiver test did or did not verify. Never claim a browser tab can continue capturing through OS sleep, USB removal, or full browser freeze/discard.

Do not discard or reset existing user changes when working in this repository.
