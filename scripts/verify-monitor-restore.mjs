import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { samplesFromLiveState } from "../src/monitorSeedSamples.js";

const WINDOW_MS = 6000;
const GAP_MS = 1000;
const eventStart = 1_800_000_000_000;
const eventEnd = eventStart + 5 * 60 * 60 * 1000;
const bandsByPilot = {};
const latestSamplesByReceiver = {};

for (let receiverId = 1; receiverId <= 9; receiverId += 1) {
  const pilotId = `pilot-${receiverId}`;
  bandsByPilot[pilotId] = Array.from({ length: 45 }, (_, index) => ({
    state: index % 3 === 0 ? "flying" : "idle",
    start: eventStart + index * 400_000,
    end: eventStart + (index + 1) * 400_000 - (index % 7 === 0 ? 2500 : 200),
  }));
  latestSamplesByReceiver[receiverId] = {
    receiverId,
    time: eventEnd,
    channels: { ch3: 1500 },
    armed: false,
    flying: false,
    turtle: false,
  };
}

const seed = { bandsByPilot, latestSamplesByReceiver };
const originalBands = JSON.stringify(bandsByPilot);
const started = performance.now();
for (let heartbeat = 0; heartbeat < 50; heartbeat += 1) {
  for (let receiverId = 1; receiverId <= 9; receiverId += 1) {
    const samples = samplesFromLiveState(seed, `pilot-${receiverId}`, receiverId, WINDOW_MS, GAP_MS);
    assert.ok(samples.length > 0 && samples.length <= 14, "five-hour history expanded into more than a bounded current window");
    assert.ok(samples.every((sample) => sample.time >= eventEnd - WINDOW_MS - 5000), "old history entered the live context");
    assert.equal(samples.at(-1).time, eventEnd, "latest receiver sample was lost");
    assert.equal(samples.at(-1).receiverId, receiverId, "receiver assignment changed during restoration");
  }
}
const elapsedMs = performance.now() - started;
assert.ok(elapsedMs < 1000, `450 long-event restorations took ${elapsedMs.toFixed(0)} ms`);
assert.equal(JSON.stringify(bandsByPilot), originalBands, "authoritative history was mutated");

const gapSeed = {
  bandsByPilot: { "pilot-1": [
    { state: "flying", start: eventEnd - 10_000, end: eventEnd - 5000 },
    { state: "idle", start: eventEnd - 2000, end: eventEnd - 1000 },
  ] },
  latestSamplesByReceiver: { 1: latestSamplesByReceiver[1] },
};
const gapSamples = samplesFromLiveState(gapSeed, "pilot-1", 1, WINDOW_MS, GAP_MS);
assert.ok(gapSamples.some((sample) => sample.time === eventEnd - 5000));
assert.ok(gapSamples.some((sample) => sample.time === eventEnd - 2000));
assert.ok(gapSamples.every((sample) => sample.time <= eventEnd - 5000 || sample.time >= eventEnd - 2000),
  "restoration fabricated samples inside a real three-second gap");
assert.ok(gapSamples.every((sample) => sample.time <= eventEnd - 1000 || sample.time === eventEnd),
  "restoration fabricated samples between the final band and the latest frame");
assert.equal(gapSamples.find((sample) => sample.time === eventEnd - 5000)?.flying, true,
  "restored band state changed");
assert.equal(gapSamples.at(-1)?.flying, false, "latest live state was replaced by historical band state");

const legacySamples = Array.from({ length: 90_000 }, (_, index) => ({
  receiverId: 1,
  time: eventStart + index * 200,
  channels: { ch3: index % 2 ? 1500 : 1400 },
}));
const legacySeed = { samplesByPilot: { "pilot-1": legacySamples } };
const legacy = samplesFromLiveState(legacySeed, "pilot-1", 1, WINDOW_MS, GAP_MS);
assert.ok(legacy.length <= 56 && legacy.length >= 50, "legacy sample history was not bounded to flight context");
assert.equal(legacy.at(-1).time, legacySamples.at(-1).time);
assert.equal(legacySamples.length, 90_000, "source samples were mutated");
assert.deepEqual(samplesFromLiveState(seed, "missing", 99, WINDOW_MS, GAP_MS), []);

console.log(`Monitor restoration passed: 5 h, 9 pilots, 401+ bands, 450 heartbeats in ${elapsedMs.toFixed(1)} ms.`);
