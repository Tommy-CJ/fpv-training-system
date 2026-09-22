const DEFAULT_MAX_SOURCE_GAP_MS = 6 * 60 * 60 * 1000;
const DEFAULT_LIVE_ANCHOR_SLACK_MS = 250;
const DEFAULT_LIVE_CATCHUP_STEP_MS = 150;
const DEFAULT_LIVE_CADENCE_LIMIT_MS = 500;

function packetSourceTime(packet) {
  const value = Number(packet?.t);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

// The receiver hub includes a millisecond monotonic clock in every rx_batch.
// Keep a wall-clock anchor so frames already waiting in the OS/browser serial
// buffer retain their original spacing when JavaScript is scheduled again.
// Without this mapping, every buffered frame receives the same Date.now() and
// a long background pause becomes one timestamp followed by a real gap.
export function createSerialCaptureClock({
  maxSourceGapMs = DEFAULT_MAX_SOURCE_GAP_MS,
  liveAnchorSlackMs = DEFAULT_LIVE_ANCHOR_SLACK_MS,
  liveCatchupStepMs = DEFAULT_LIVE_CATCHUP_STEP_MS,
  liveCadenceLimitMs = DEFAULT_LIVE_CADENCE_LIMIT_MS,
} = {}) {
  let lastSourceTime = null;
  let lastCapturedAt = null;
  let lastObservedAt = null;
  let steadyFrames = 0;

  return {
    capture(packet, observedAt = Date.now()) {
      const safeObservedAt = Number.isFinite(Number(observedAt)) ? Number(observedAt) : Date.now();
      const sourceTime = packetSourceTime(packet);
      if (sourceTime === null) return safeObservedAt;

      if (lastSourceTime === null || lastCapturedAt === null) {
        lastSourceTime = sourceTime;
        lastCapturedAt = safeObservedAt;
        lastObservedAt = safeObservedAt;
        steadyFrames = 0;
        return safeObservedAt;
      }

      const sourceDelta = sourceTime - lastSourceTime;
      if (sourceDelta < 0 || sourceDelta > maxSourceGapMs) {
        // Device reboot, counter wrap, or an implausibly long disconnect.
        lastSourceTime = sourceTime;
        lastCapturedAt = safeObservedAt;
        lastObservedAt = safeObservedAt;
        steadyFrames = 0;
        return safeObservedAt;
      }

      const predictedAt = lastCapturedAt + sourceDelta;
      const bufferedLagMs = safeObservedAt - predictedAt;
      const observedDelta = safeObservedAt - lastObservedAt;
      // A burst of buffered serial frames advances the hub clock much faster
      // than the browser clock. Conversely, consecutive normally paced reads
      // prove that the burst has drained. Re-anchor those reads gradually: the
      // old algorithm kept a >250 ms scheduling pause forever, so repeated
      // small pauses eventually made healthy online frames look >3 s old.
      const normallyPaced = sourceDelta > 0
        && sourceDelta <= liveCadenceLimitMs
        && observedDelta >= sourceDelta * 0.5
        && observedDelta <= sourceDelta * 2 + 40;
      steadyFrames = normallyPaced ? steadyFrames + 1 : 0;
      // While frames arrive normally, keep re-anchoring to wall time so small
      // oscillator drift can never accumulate into a false historical delay.
      // A large positive lag means this really is an OS/browser-buffered burst;
      // preserve the hardware interval until the burst catches up. Two steady
      // reads then correct at most one bounded step per frame, keeping sample
      // gaps well under the one-second real-gap threshold.
      const capturedAt = bufferedLagMs >= 0 && bufferedLagMs <= liveAnchorSlackMs
        ? safeObservedAt
        : Math.min(
          safeObservedAt,
          predictedAt + (bufferedLagMs > liveAnchorSlackMs && steadyFrames >= 2 ? liveCatchupStepMs : 0),
        );
      lastSourceTime = sourceTime;
      lastCapturedAt = capturedAt;
      lastObservedAt = safeObservedAt;
      return capturedAt;
    },
    reset() {
      lastSourceTime = null;
      lastCapturedAt = null;
      lastObservedAt = null;
      steadyFrames = 0;
    },
  };
}

export { DEFAULT_LIVE_ANCHOR_SLACK_MS, DEFAULT_LIVE_CATCHUP_STEP_MS, DEFAULT_MAX_SOURCE_GAP_MS, packetSourceTime };
