const FLIGHT_CONTEXT_MS = 5000;

function sampleFromBand(band, time, pilotId, receiverId, latestSample) {
  return {
    ...latestSample,
    time,
    pilotId,
    receiverId,
    armed: band.state === "flying" || band.state === "turtle",
    flying: band.state === "flying",
    turtle: band.state === "turtle",
  };
}

export function samplesFromLiveState(seed, pilotId, receiverId, recentWindowMs, maxSampleGapMs) {
  const storedSamples = seed?.samplesByPilot?.[pilotId];
  if (storedSamples?.length) {
    let newestTime = 0;
    for (const sample of storedSamples) {
      if (Number(sample.receiverId) === Number(receiverId)) {
        newestTime = Math.max(newestTime, Number(sample.time) || 0);
      }
    }
    const cutoff = newestTime - recentWindowMs - FLIGHT_CONTEXT_MS;
    return storedSamples
      .filter((sample) => Number(sample.receiverId) === Number(receiverId) && Number(sample.time) >= cutoff)
      .map((sample) => ({ ...sample, pilotId, receiverId }))
      .sort((a, b) => a.time - b.time);
  }

  const latestSample = seed?.latestSamplesByReceiver?.[receiverId] || null;
  if (!latestSample) return [];
  const latestTime = Number(latestSample.time) || 0;
  const cutoff = latestTime - recentWindowMs - FLIGHT_CONTEXT_MS;
  const restored = [];
  for (const band of seed?.bandsByPilot?.[pilotId] || []) {
    if (band.end < cutoff || band.start > latestTime) continue;
    const start = Math.max(band.start, cutoff);
    const end = Math.min(band.end, latestTime);
    for (let time = start; time < end; time += maxSampleGapMs) {
      restored.push(sampleFromBand(band, time, pilotId, receiverId, latestSample));
    }
    restored.push(sampleFromBand(band, end, pilotId, receiverId, latestSample));
  }
  restored.push({ ...latestSample, pilotId, receiverId });
  return restored.sort((a, b) => a.time - b.time);
}
