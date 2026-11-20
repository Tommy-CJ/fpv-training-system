import assert from "node:assert/strict";
import { availableVideoNumbers, duplicateVideoChannel } from "../src/eventFrequency.js";
import { videoChannels } from "../src/trainingShared.js";

const participants = [
  { pilotId: "pilot-1", videoBand: "L", videoChannel: "L1" },
  { pilotId: "pilot-2", videoBand: "L", videoChannel: "" },
  { pilotId: "pilot-3", videoBand: "", videoChannel: "" },
];
assert.equal(duplicateVideoChannel(participants), "", "empty frequency is allowed before assignment");
assert.ok(!availableVideoNumbers(videoChannels.all, participants, 1, "L").includes("1"),
  "a channel used by another pilot must not be offered");
assert.ok(availableVideoNumbers(videoChannels.all, participants, 0, "L").includes("1"),
  "an existing pilot must keep their own selected channel visible");
assert.deepEqual(availableVideoNumbers(videoChannels.all, participants, 2, ""), []);
assert.equal(duplicateVideoChannel([...participants, { pilotId: "pilot-4", videoChannel: "L1" }]), "L1",
  "duplicate legacy or concurrent assignments must be rejected before saving");
console.log("Event frequency assignment verification passed.");
