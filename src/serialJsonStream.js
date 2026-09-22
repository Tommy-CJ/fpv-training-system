const DEFAULT_MAX_BUFFER_LENGTH = 256 * 1024;

// Web Serial chunks and device print calls are not message boundaries. A
// single rx_batch may contain embedded newlines or arrive over several reads,
// while reconnecting can begin in the middle of the previous packet. Extract
// complete JSON objects by brace depth instead of assuming one line = one JSON
// message. Braces inside quoted strings are ignored.
export function consumeSerialJsonStream(previousBuffer = "", chunk = "", maxBufferLength = DEFAULT_MAX_BUFFER_LENGTH) {
  const source = `${previousBuffer || ""}${chunk || ""}`;
  const frames = [];
  const failures = [];
  let frameStart = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (frameStart < 0) {
      if (character === "{") {
        frameStart = index;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        const line = source.slice(frameStart, index + 1);
        try {
          frames.push({ packet: JSON.parse(line), line });
        } catch {
          failures.push(line);
        }
        frameStart = -1;
        inString = false;
        escaped = false;
      }
    }
  }

  let buffer = frameStart >= 0 ? source.slice(frameStart) : "";
  const safeMaximum = Math.max(4096, Number(maxBufferLength) || DEFAULT_MAX_BUFFER_LENGTH);
  if (buffer.length > safeMaximum) {
    failures.push(buffer.slice(0, 160));
    // Retain only the newest plausible packet start so one permanently broken
    // frame cannot prevent all later valid receiver batches from being read.
    const latestPacketStart = buffer.lastIndexOf('{"type"');
    buffer = latestPacketStart > 0 ? buffer.slice(latestPacketStart) : "";
  }

  return { buffer, frames, failures };
}
