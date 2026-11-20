export function availableVideoNumbers(channels, participants, index, band) {
  if (!band) return [];
  const selectedByOthers = new Set(participants
    .filter((_, participantIndex) => participantIndex !== index)
    .map((participant) => participant.videoChannel)
    .filter(Boolean));
  return channels
    .filter((channel) => channel.startsWith(band) && !selectedByOthers.has(channel))
    .map((channel) => channel.slice(band.length));
}

export function duplicateVideoChannel(participants) {
  const seen = new Set();
  for (const participant of participants) {
    const channel = String(participant.videoChannel || "").trim();
    if (!channel) continue;
    if (seen.has(channel)) return channel;
    seen.add(channel);
  }
  return "";
}
