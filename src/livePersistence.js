const DEFAULT_RECENT_SAMPLE_MS = 2500;
const MAX_RAW_EXTREMA_WINDOW_MS = 500;

// A recovery backlog changes how old cached records are replayed, but it must
// never change delivery of the current 5 Hz sample. Keeping this decision in a
// small pure helper makes that invariant regression-testable.
export function shouldSendCurrentPersistence(socketReadyState, recoveryActive = false) {
  void recoveryActive;
  return socketReadyState === 1;
}

// A hidden tab may leave a timer overdue but not yet dispatched. An ACK or
// visibility wakeup must replace that stalled timer instead of treating its
// old deadline as proof that the recovery pump is already running.
export function shouldKeepScheduledOutboxFlush(existingDueAt, requestedDueAt, now = Date.now()) {
  const existing = Number(existingDueAt);
  const requested = Number(requestedDueAt);
  // Current 5 Hz frames also schedule a three-second ACK watchdog. That late
  // request must never replace an overdue recovery pump; only a fresh
  // immediate wakeup (ACK, reconnect, visibility) should do so.
  return existing <= requested && (existing > Number(now) || requested > Number(now));
}

const OUTBOX_SUCCESS_ACK_STATUSES = new Set(["persisted", "processed", "duplicate"]);

export function shouldDeleteOutboxPacketForAck(message) {
  // Older servers could ACK a compacted durable frame as accepted even though
  // it was never sampled. Keep the IndexedDB record for explicit replay.
  if (message?.sampled === false) return false;
  const status = String(message?.status || "");
  if (status) return OUTBOX_SUCCESS_ACK_STATUSES.has(status);
  // Compatibility with a rolling deployment where the browser can reconnect
  // to an older server that only returned the accepted boolean.
  return message?.accepted === true;
}

export function shouldDiscardOrphanedOutboxPacket(message) {
  return String(message?.status || "") === "orphaned"
    || message?.orphaned === true
    || message?.rejected === true;
}

export function outboxAckRetryDelay(message) {
  const status = String(message?.status || "");
  if (status === "orphaned" || message?.orphaned || message?.rejected) {
    return Math.max(30_000, Number(message?.retryAfterMs) || 0);
  }
  return Math.max(500, Number(message?.retryAfterMs) || 1000);
}
// A reconnect captures the last sequence that existed before the socket came
// back. Only that frozen generation belongs to historical recovery; newer
// online packets must not keep the completion condition open forever.
export function isHistoricalRecoveryRecord(record, cutoffSequence, cutoffCapturedAt = 0) {
  const capturedAt = Number(record?.capturedAt);
  const capturedAtCutoff = Number(cutoffCapturedAt);
  // Capture time survives browser/session sequence resets and also recognizes
  // records created by older builds that did not store clientSequence.
  if (Number.isFinite(capturedAt) && capturedAt > 0 && Number.isFinite(capturedAtCutoff) && capturedAtCutoff > 0) {
    return capturedAt <= capturedAtCutoff;
  }
  const sequence = Number(record?.clientSequence);
  const cutoff = Number(cutoffSequence);
  return Number.isFinite(sequence) && sequence > 0 && Number.isFinite(cutoff) && cutoff > 0 && sequence <= cutoff;
}

function compactLatestSample(sample) {
  const receiverId = Number(sample?.receiverId);
  const rawChannels = Array.isArray(sample?.rawChannels)
    ? sample.rawChannels.slice(0, 8).map(Number)
    : [];
  if (!Number.isFinite(receiverId) || receiverId < 1 || rawChannels.length < 8) return null;
  if (rawChannels.some((value) => !Number.isFinite(value) || value < 172 || value > 1811)) return null;

  const item = { rx: receiverId, ch: rawChannels };
  const linkQuality = Number(sample?.lq);
  const rssi = Number(sample?.rssi);
  const sourceTime = Number(sample?.sourceTime);
  if (Number.isFinite(linkQuality)) item.lq = linkQuality;
  if (Number.isFinite(rssi)) item.rssi = rssi;
  if (Number.isFinite(sourceTime)) item.t = sourceTime;
  return item;
}

// PROTECTED PIPELINE BOUNDARY (docs/LIVE_DATA_PIPELINE.md): the receiver hub
// may deliver one receiver, a subset, or the whole array in a serial frame.
// History sampling therefore has to be per receiver rather than selecting one
// arbitrary frame every 200 ms. Keep this as raw receiver evidence inside the
// existing durable frame; never upload browser-derived flight state or create
// a second online persistence stream. The 30 Hz relay stays untouched.
export function buildPersistenceSerialSnapshot(
  latestByReceiver,
  capturedAt = Date.now(),
  recentSampleMs = DEFAULT_RECENT_SAMPLE_MS,
  samplesByReceiver = null,
  windowStartedAt = capturedAt,
) {
  const items = Object.values(latestByReceiver || {})
    .filter((sample) => capturedAt - Number(sample?.time || 0) <= recentSampleMs)
    .map((sample) => compactLatestSample(sample))
    .filter(Boolean)
    .sort((left, right) => left.rx - right.rx);
  if (!items.length) return null;
  const itemReceiverIds = new Set(items.map((item) => item.rx));
  const history = [];
  // A durable row represents one approximately 200 ms sample window. After
  // a serial clock reset or a long scheduling pause, the previous durable
  // timestamp can be seconds old. Including every queued raw sample since
  // then imports a former throttle movement into a *current idle* row, whose
  // five-second server state window then paints a false green interval. Keep
  // the true raw extrema, but only from the bounded window of this row.
  const extremaWindowStartedAt = Math.max(
    Number(windowStartedAt) || 0,
    capturedAt - MAX_RAW_EXTREMA_WINDOW_MS,
  );
  for (const [receiverKey, queuedSamples] of Object.entries(samplesByReceiver || {})) {
    const receiverId = Number(receiverKey);
    if (!itemReceiverIds.has(receiverId) || !Array.isArray(queuedSamples)) continue;
    const candidates = queuedSamples.filter((sample) => (
      Number(sample?.time) > extremaWindowStartedAt
      && Number(sample?.time) <= capturedAt
      && Number(sample?.receiverId) === receiverId
      && Array.isArray(sample?.rawChannels)
      && Number.isFinite(Number(sample.rawChannels[2]))
    ));
    if (!candidates.length) continue;
    let lowest = candidates[0];
    let highest = candidates[0];
    for (const sample of candidates.slice(1)) {
      if (Number(sample.rawChannels[2]) < Number(lowest.rawChannels[2])) lowest = sample;
      if (Number(sample.rawChannels[2]) > Number(highest.rawChannels[2])) highest = sample;
    }
    const compactLowest = compactLatestSample(lowest);
    const compactHighest = compactLatestSample(highest);
    if (compactLowest) history.push(compactLowest);
    if (compactHighest && highest !== lowest) history.push(compactHighest);
  }
  const snapshot = { type: "rx_batch", v: 1, t: capturedAt, items };
  // These are real receiver samples, not browser-derived flight state. Two
  // extrema per receiver losslessly preserve everything the server needs for
  // its five-second throttle-spread rule without turning SQLite into 30 Hz.
  if (history.length) snapshot.history = history;
  return snapshot;
}
