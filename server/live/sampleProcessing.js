function crsfToPwm(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.round(((number - 172) * 1000) / (1811 - 172) + 1000);
}

function isValidCrsfChannel(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 172 && number <= 1811;
}

function isValueInRanges(value, ranges) {
  return ranges?.some((range) => value >= Number(range.min) && value <= Number(range.max));
}

function getRanges(config, type) {
  const entries = [];
  Object.entries(config || {}).forEach(([channelKey, ranges]) => {
    (ranges || []).forEach((range) => {
      if (range.type === type) entries.push({ ...range, channelKey });
    });
  });
  return entries;
}

function getPilotMode(pilot, sample) {
  const channels = sample?.channels || {};
  const modeRanges = getRanges(pilot?.channelConfig || {}, "mode");
  return modeRanges.find((range) => isValueInRanges(channels[range.channelKey], [range]))?.name || "Acro";
}

function getPilotState(pilot, sample, recentSamples) {
  const channels = sample?.channels || {};
  const config = pilot?.channelConfig || {};
  const armRanges = getRanges(config, "arm");
  const turtleRanges = getRanges(config, "turtle");
  const armed = armRanges.some((range) => isValueInRanges(channels[range.channelKey], [range]));
  const turtleSwitch = turtleRanges.some((range) => isValueInRanges(channels[range.channelKey], [range]));
  // Frozen state rule: server-owned, armed now, and >80 throttle spread over
  // the preceding five seconds. Do not replace this with absolute throttle,
  // stick offset, client-provided state, or hysteresis/hold-time shortcuts.
  const throttleValues = recentSamples.flatMap((item) => [
    item.channels?.ch3,
    item.throttleMin,
    item.throttleMax,
  ]).filter((value) => Number.isFinite(value));
  const throttleSpread = throttleValues.length ? Math.max(...throttleValues) - Math.min(...throttleValues) : 0;
  const turtle = armed && turtleSwitch;
  const flying = armed && throttleSpread > 80;
  return { armed, mode: getPilotMode(pilot, sample), turtleSwitch, turtle, flying, idle: !turtle && !flying, throttleSpread };
}

function parseSerialPacket(packet, receivedAt = Date.now()) {
  const frameTime = Number(packet?.t) || null;
  const items = packet?.type === "rx_batch" && Array.isArray(packet.items) ? packet.items : [packet];
  const throttleWindowByReceiver = new Map();
  const historyItems = packet?.type === "rx_batch" && Array.isArray(packet.history)
    ? packet.history.slice(-512)
    : [];
  for (const item of historyItems) {
    const receiverId = Number(item?.rx);
    const rawThrottle = Number(Array.isArray(item?.ch) ? item.ch[2] : NaN);
    if (!Number.isFinite(receiverId) || receiverId < 1 || !isValidCrsfChannel(rawThrottle)) continue;
    const throttle = crsfToPwm(rawThrottle);
    const existing = throttleWindowByReceiver.get(receiverId);
    throttleWindowByReceiver.set(receiverId, {
      min: existing ? Math.min(existing.min, throttle) : throttle,
      max: existing ? Math.max(existing.max, throttle) : throttle,
    });
  }
  const samples = [];

  for (const item of items) {
    const receiverId = Number(item?.rx);
    const channels = Array.isArray(item?.ch) ? item.ch : [];
    if (!Number.isFinite(receiverId) || receiverId < 1 || channels.length < 8) continue;

    const rawChannels = channels.slice(0, 8).map(Number);
    if (rawChannels.some((value) => !isValidCrsfChannel(value))) continue;

    const pwmChannels = rawChannels.map(crsfToPwm);
    if (pwmChannels.some((value) => value === null)) continue;

    const linkQuality = Number(item.lq ?? item.linkQuality ?? 0);
    const rssi = Number(item.rssi ?? -127);
    const throttleWindow = throttleWindowByReceiver.get(receiverId);
    samples.push({
      time: receivedAt,
      sourceTime: Number(item.t) || frameTime,
      receiverId,
      rawChannels,
      lq: Number.isFinite(linkQuality) ? linkQuality : 0,
      rssi: Number.isFinite(rssi) ? rssi : -127,
      channels: {
        ch1: pwmChannels[0],
        ch2: pwmChannels[1],
        ch3: pwmChannels[2],
        ch4: pwmChannels[3],
        ch5: pwmChannels[4],
        ch6: pwmChannels[5],
        ch7: pwmChannels[6],
        ch8: pwmChannels[7],
      },
      throttleMin: Math.min(pwmChannels[2], throttleWindow?.min ?? pwmChannels[2]),
      throttleMax: Math.max(pwmChannels[2], throttleWindow?.max ?? pwmChannels[2]),
    });
  }

  return samples;
}

function compactLiveItem(item) {
  const compact = {
    rx: Number(item?.rx),
    ch: Array.isArray(item?.ch) ? item.ch.slice(0, 8).map(Number) : [],
  };
  const lq = Number(item?.lq ?? item?.linkQuality);
  const rssi = Number(item?.rssi);
  if (Number.isFinite(lq)) compact.lq = lq;
  if (Number.isFinite(rssi)) compact.rssi = rssi;
  return compact;
}

function compactLiveBatch(packet) {
  if (!packet || typeof packet !== "object") return packet;
  if (packet.type === "rx_batch" && Array.isArray(packet.items)) {
    const compact = {
      type: "rx_batch",
      items: packet.items.map(compactLiveItem).filter((item) => Number.isFinite(item.rx) && item.ch.length >= 8),
    };
    return compact;
  }
  return compactLiveItem(packet);
}

export { compactLiveBatch, getPilotState, parseSerialPacket };
