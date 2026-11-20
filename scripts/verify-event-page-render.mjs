import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const vite = await createServer({ server: { middlewareMode: true }, appType: "custom" });
try {
  const { default: EventPage } = await vite.ssrLoadModule("/src/pages/EventPage.jsx");
  const html = renderToStaticMarkup(React.createElement(EventPage, {
    pilots: [{ id: "pilot-1", name: "张晨" }, { id: "pilot-2", name: "李博" }],
    events: [
      { id: "event-old", name: "旧训练", active: false, participants: [], records: [] },
      { id: "event-live", name: "当前训练", active: true, participants: [
        { pilotId: "pilot-1", receiverId: 1, videoBand: "L", videoChannel: "L1" },
        { pilotId: "pilot-2", receiverId: 2, videoBand: "L", videoChannel: "" },
      ], records: [] },
    ],
    live: { receivers: [] },
    serialState: { supported: true },
    onSaveEvents: async () => {},
  }));
  const eventOptions = html.match(/<select[^>]*aria-label="选择训练事件"[^>]*>(.*?)<\/select>/s)?.[1] || "";
  const secondPilotNumbers = html.match(/<select[^>]*aria-label="飞手 2 图传频道"[^>]*>(.*?)<\/select>/s)?.[1] || "";
  assert.match(eventOptions, /value="event-old"/);
  assert.match(eventOptions, /value="event-live"/);
  assert.match(eventOptions, /value="event-live" selected=""/);
  assert.match(secondPilotNumbers, /选择频道/);
  assert.doesNotMatch(secondPilotNumbers, /value="1"/, "L1 is already assigned to another pilot");
  assert.match(secondPilotNumbers, /value="2"/, "other channels remain selectable");
  assert.match(html, /张晨<\/strong>.*?接收机 RX 1/s, "coach receiver card uses the assigned pilot name");
  console.log("Event selector and frequency form rendering passed.");
} finally {
  await vite.close();
}
