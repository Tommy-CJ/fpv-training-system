import assert from "node:assert/strict";
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

console.log(JSON.stringify({ ok: true, reassembledReceivers: firstPacket.items.length, concatenatedFrames: 2 }));
