import assert from "node:assert/strict";
import { createSerialCaptureClock } from "../src/serialCaptureClock.js";
import { consumeSerialJsonStream } from "../src/serialJsonStream.js";

const firstPacket = {
  type: "rx_batch",
  v: 1,
  role: "master",
  Vin_mV: 5077,
  A_mA: 752,
  t: 282630,
  items: [
    { rx: 1, ch: [992, 992, 172, 992, 1811, 172, 172, 172], lq: 100, rssi: -29 },
    { rx: 2, ch: [992, 992, 1811, 992, 1811, 172, 172, 172], lq: 99, rssi: -31 },
  ],
};
const secondPacket = {
  type: "rx_batch",
  v: 1,
  t: 282830,
  items: [{ rx: 3, ch: [992, 992, 1200, 992, 1811, 172, 172, 172], lq: 98, rssi: -30 }],
};

let state = consumeSerialJsonStream("", "-29}]}\r\n");
assert.equal(state.frames.length, 0, "a reconnect tail must not become a false packet");
assert.equal(state.buffer, "", "a reconnect tail must not poison the next packet");

const encodedFirst = JSON.stringify(firstPacket);
const wrapAt = encodedFirst.indexOf(',"items"');
state = consumeSerialJsonStream(state.buffer, `${encodedFirst.slice(0, wrapAt + 1)}\r\n`);
assert.equal(state.frames.length, 0, "a newline-split packet must wait for its tail");
state = consumeSerialJsonStream(state.buffer, `${encodedFirst.slice(wrapAt + 1)}\r\n`);
assert.deepEqual(state.frames.map(({ packet }) => packet), [firstPacket], "a newline-split packet must be reassembled exactly");

const encodedSecond = JSON.stringify(secondPacket);
state = consumeSerialJsonStream(state.buffer, `${encodedFirst}${encodedSecond}`);
assert.deepEqual(
  state.frames.map(({ packet }) => packet),
  [firstPacket, secondPacket],
  "concatenated packets must be separated by JSON structure rather than line endings",
);

state = consumeSerialJsonStream("", '{"type":"rx_batch","items":[}]{"rx":4,"ch":[992,992,172,992,1811,172,172,172]}');
assert.equal(state.failures.length, 1, "a balanced malformed frame must still be reported");
assert.equal(state.frames.at(-1)?.packet?.rx, 4, "a malformed frame must not prevent the following valid frame");

const truncatedPacket = encodedFirst.slice(0, Math.floor(encodedFirst.length / 2));
state = consumeSerialJsonStream("", `${truncatedPacket}${encodedSecond}`);
assert.equal(state.failures.length, 1, "a truncated packet must be reported at the next packet header");
assert.deepEqual(
  state.frames.map(({ packet }) => packet),
  [secondPacket],
  "one truncated USB frame must not poison the valid packets that follow it",
);
assert.equal(state.buffer, "", "packet-header recovery must leave no poisoned tail");

const splitRecoveryAt = Math.floor(encodedSecond.length / 3);
state = consumeSerialJsonStream("", truncatedPacket);
state = consumeSerialJsonStream(state.buffer, encodedSecond.slice(0, splitRecoveryAt));
assert.equal(state.failures.length, 1, "a split replacement header must still abandon the truncated frame");
assert.equal(state.frames.length, 0, "a split replacement packet must wait for its tail");
state = consumeSerialJsonStream(state.buffer, encodedSecond.slice(splitRecoveryAt));
assert.deepEqual(state.frames.map(({ packet }) => packet), [secondPacket], "split replacement packet was not recovered");

const truncatedInsideString = `${encodedFirst.slice(0, encodedFirst.indexOf('"items"') + 2)}${encodedSecond}`;
state = consumeSerialJsonStream("", truncatedInsideString);
assert.equal(state.failures.length, 1, "a packet truncated inside a JSON string must resynchronize");
assert.deepEqual(state.frames.map(({ packet }) => packet), [secondPacket], "string-state truncation poisoned the next packet");

const packetWithHeaderText = {
  ...secondPacket,
  note: 'diagnostic {"type":"rx_batch","items":[]} text',
};
state = consumeSerialJsonStream("", JSON.stringify(packetWithHeaderText));
assert.equal(state.failures.length, 0, "a packet-shaped string value must not trigger resynchronization");
assert.deepEqual(state.frames.map(({ packet }) => packet), [packetWithHeaderText], "string content corrupted a valid packet");

const captureClock = createSerialCaptureClock();
assert.equal(captureClock.capture({ t: 1000 }, 10_000), 10_000, "first hardware timestamp must anchor to wall time");
assert.equal(captureClock.capture({ t: 1100 }, 10_100), 10_100, "foreground timing must retain its source spacing");
assert.equal(
  captureClock.capture({ t: 1200 }, 20_000),
  10_200,
  "frames buffered while the page is suspended must keep their hardware-time spacing",
);
assert.equal(captureClock.capture({ t: 1300 }, 20_001), 10_300, "a buffered burst must not collapse onto one Date.now()");
assert.equal(captureClock.capture({ t: 50 }, 20_100), 20_100, "a hardware clock reset must establish a new wall-time anchor");
assert.equal(captureClock.capture({ t: 150 }, 20_220), 20_220, "live frames must re-anchor so hardware oscillator drift cannot accumulate");

const jitterClock = createSerialCaptureClock();
let jitterSourceAt = 1000;
let jitterObservedAt = 10_000;
jitterClock.capture({ t: jitterSourceAt }, jitterObservedAt);
let largestJitterGap = 0;
let previousJitterCapture = jitterObservedAt;
for (let index = 0; index < 120; index += 1) {
  jitterSourceAt += 200;
  jitterObservedAt += index % 10 === 0 ? 600 : 200;
  const capturedAt = jitterClock.capture({ t: jitterSourceAt }, jitterObservedAt);
  largestJitterGap = Math.max(largestJitterGap, capturedAt - previousJitterCapture);
  previousJitterCapture = capturedAt;
}
assert.ok(
  jitterObservedAt - previousJitterCapture < 3000,
  "repeated foreground scheduling pauses must not turn live frames into permanent historical backfill",
);
assert.ok(largestJitterGap <= 1000, "catching up must not invent a real timeline gap");

const burstClock = createSerialCaptureClock();
burstClock.capture({ t: 1000 }, 10_000);
const burstCapture = burstClock.capture({ t: 1200 }, 20_000);
for (let index = 2; index <= 10; index += 1) {
  assert.equal(
    burstClock.capture({ t: 1000 + index * 200 }, 20_000 + index),
    burstCapture + (index - 1) * 200,
    "a real buffered burst must retain the source interval while it drains",
  );
}

console.log(JSON.stringify({ ok: true, reassembledReceivers: firstPacket.items.length, concatenatedFrames: 2, truncatedRecovery: true, bufferedTimeRecovery: true }));
