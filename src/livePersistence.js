const DEFAULT_RECENT_SAMPLE_MS = 2500;

// A recovery backlog changes how old cached records are replayed, but it must
// never change delivery of the current 5 Hz sample. Keeping this decision in a
// small pure helper makes that invariant regression-testable.
export function shouldSendCurrentPersistence(socketReadyState, recoveryActive = false) {
  void recoveryActive;
  return socketReadyState === 1;
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

// The receiver hub may deliver one receiver, a subset, or the whole array in a
// serial frame. History sampling therefore has to be per receiver rather than
// selecting one arbitrary serial frame every 200 ms. This snapshot keeps the
// newest recent value for every receiver while the 30 Hz relay stays untouched.
export function buildPersistenceSerialSnapshot(latestByReceiver, capturedAt = Date.now(), recentSampleMs = DEFAULT_RECENT_SAMPLE_MS) {
  const items = Object.values(latestByReceiver || {})
    .filter((sample) => capturedAt - Number(sample?.time || 0) <= recentSampleMs)
    .map(compactLatestSample)
    .filter(Boolean)
    .sort((left, right) => left.rx - right.rx);
  if (!items.length) return null;
  return { type: "rx_batch", v: 1, t: capturedAt, items };
}
