import assert from "node:assert/strict";
import { createServer } from "vite";

const server = await createServer({
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
});

let api;
try {
  await server.ssrLoadModule("/src/App.jsx");
  api = globalThis.__FPV_BRACKET_TEST_API__;
} finally {
  await server.close();
}
assert.ok(api, "无法加载核心对阵测试接口");
delete globalThis.__FPV_BRACKET_TEST_API__;

const FORMATS = ["duel", "triple", "quad"];
const PLAYER_COUNTS = Array.from({ length: 13 }, (_, index) => index + 4);

function decisiveResults(match, preferBack = false) {
  return match.slots.map((player, index) => {
    if (!api.isRealPlayer(player)) return { laps: "", seconds: "", dnf: false };
    const rank = preferBack ? match.slots.length - 1 - index : index;
    return { laps: "3", seconds: String(10 + rank), dnf: false, timerInProgress: false };
  });
}

function completeMatch(rawBracket, matchId, preferBack = false) {
  const nextRaw = api.cloneBracket(rawBracket);
  const computed = api.recomputeBracket(nextRaw, false);
  const visibleMatch = api.findMatch(computed, matchId);
  const storedMatch = api.findMatch(nextRaw, matchId);
  assert.ok(visibleMatch && storedMatch, `找不到待完成比赛 ${matchId}`);
  storedMatch.results = decisiveResults(visibleMatch, preferBack);
  storedMatch.manualWinnerSlot = null;
  storedMatch.manualAdvancingSlots = [];
  return api.finishBracketMatch(nextRaw, matchId, 30000);
}

function routeIntegrity(rawBracket, label) {
  const matches = api.allMatches(rawBracket);
  const matchById = new Map(matches.map((match) => [match.id, match]));
  const inbound = new Set();
  const edges = new Map(matches.map((match) => [match.id, []]));

  for (const match of matches) {
    for (const target of api.matchRouteTargets(match)) {
      const targetMatch = matchById.get(target.matchId);
      assert.ok(targetMatch, `${label}: ${match.id} 指向不存在的比赛 ${target.matchId}`);
      assert.ok(Number.isInteger(target.slot) && target.slot >= 0 && target.slot < targetMatch.slots.length, `${label}: ${match.id} 的目标槽位越界`);
      const targetKey = `${target.matchId}:${target.slot}`;
      assert.ok(!inbound.has(targetKey), `${label}: 目标槽位 ${targetKey} 被多条路由占用`);
      inbound.add(targetKey);
      edges.get(match.id).push(target.matchId);
    }
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(matchId) {
    assert.ok(!visiting.has(matchId), `${label}: 路由图存在循环，涉及 ${matchId}`);
    if (visited.has(matchId)) return;
    visiting.add(matchId);
    for (const targetId of edges.get(matchId) || []) visit(targetId);
    visiting.delete(matchId);
    visited.add(matchId);
  }
  for (const match of matches) visit(match.id);
}

function recordLosses(losses, match) {
  const addLoss = (player) => {
    if (!api.isRealPlayer(player)) return;
    losses.set(player.id, (losses.get(player.id) || 0) + 1);
    assert.ok(losses.get(player.id) <= 2, `${player.id} 出现超过两败`);
  };

  if (api.isMultiMatch(match)) {
    for (const player of match.eliminated || []) addLoss(player);
    return;
  }
  addLoss(match.loser);
}

function assertHighlightOrder(rawBracket, label) {
  const computed = api.recomputeBracket(rawBracket);
  const queue = api.getPlayableQueue(computed);
  const current = queue[0] || null;
  const currentMarks = api.allMatches(computed).filter((match) => match.highlight === "current");
  const nextMarks = api.allMatches(computed).filter((match) => match.highlight === "next1");

  assert.equal(currentMarks.length, current ? 1 : 0, `${label}: 当前局标记数量错误`);
  if (current) assert.equal(currentMarks[0].id, current.id, `${label}: 当前局不是可比赛队列第一场`);
  assert.ok(nextMarks.length <= 1, `${label}: 下一局标记超过一个`);

  if (!current) return { current: null, predictedNextId: null };
  const finished = completeMatch(rawBracket, current.id);
  const actualNextId = finished.nextMatch?.id || null;
  assert.equal(nextMarks[0]?.id || null, actualNextId, `${label}: 蓝色下一局与结束当前局后的实际跳转不一致`);
  return { current, predictedNextId: nextMarks[0]?.id || null };
}

function assertEverySelectableMatchOrder(rawBracket, label) {
  const computed = api.recomputeBracket(rawBracket, false);
  for (const selected of api.getPlayableQueue(computed)) {
    const annotated = api.cloneBracket(computed);
    api.annotateMatchHighlights(annotated, selected.id);
    const markedCurrent = api.allMatches(annotated).find((match) => match.highlight === "current");
    const markedNext = api.allMatches(annotated).find((match) => match.highlight === "next1");
    const finished = completeMatch(rawBracket, selected.id);
    assert.equal(markedCurrent?.id, selected.id, `${label}: 手动选择 ${selected.id} 后当前局错误`);
    assert.equal(markedNext?.id || null, finished.nextMatch?.id || null, `${label}: 手动选择 ${selected.id} 后的下一局顺序错误`);
  }
}

function simulateTournament(playerCount, format, forceReset = false, outcome = "front") {
  const label = `${playerCount}人 ${format} ${outcome === "back" ? "后槽优胜" : "前槽优胜"}${forceReset ? " 重赛分支" : ""}`;
  let raw = api.createTournament(playerCount, format);
  raw.players = raw.players.map((player) => ({ ...player, name: `飞手${player.seed}` }));
  routeIntegrity(raw, label);

  const losses = new Map(raw.players.map((player) => [player.id, 0]));
  const played = [];
  let resetForced = false;

  for (let guard = 0; guard < 300; guard += 1) {
    const computed = api.recomputeBracket(raw);
    if (computed.champion) {
      for (const player of computed.players) {
        const lossCount = losses.get(player.id) || 0;
        if (player.id === computed.champion.id) assert.ok(lossCount <= 1, `${label}: 冠军 ${player.id} 不应达到两败`);
        else assert.equal(lossCount, 2, `${label}: 非冠军 ${player.id} 应恰好两败，实际 ${lossCount}`);
      }
      if (forceReset) assert.ok(resetForced && played.includes("GF-1"), `${label}: 未进入总决赛重赛`);
      return { champion: computed.champion.id, matches: played.length, played };
    }

    const { current } = assertHighlightOrder(raw, `${label} 第${played.length + 1}局`);
    assert.ok(current, `${label}: 尚未产生冠军但没有可进行的比赛`);
    assertEverySelectableMatchOrder(raw, `${label} 第${played.length + 1}局`);
    const preferBack = outcome === "back" || (forceReset && current.id === "GF-0");
    const finished = completeMatch(raw, current.id, preferBack);
    assert.ok(finished.finishedMatch && api.isMatchComplete(finished.finishedMatch), `${label}: ${current.id} 完成后仍未结算`);
    recordLosses(losses, finished.finishedMatch);
    played.push(current.id);
    if (forceReset && current.id === "GF-0") resetForced = true;
    raw = finished.rawBracket;
  }
  assert.fail(`${label}: 300 局内未能结束，疑似死锁`);
}

function verifyPendingSlotsDoNotAdvance() {
  for (const format of ["triple", "quad"]) {
    const heatSize = format === "triple" ? 3 : 4;
    const advanceCount = 2;
    const pending = api.createMultiRound("TEST", 0, [heatSize], advanceCount, "待定测试", "eliminate", heatSize)[0];
    pending.slots[0] = api.createPlayers(1)[0];
    pending.results[0] = { laps: "3", seconds: "10", dnf: false };
    assert.equal(api.resolveMultiResult(pending).advancing.length, 0, `${format}: 有待定槽位时不应提前晋级`);
  }
}

verifyPendingSlotsDoNotAdvance();

const summaries = [];
for (const format of FORMATS) {
  for (const playerCount of PLAYER_COUNTS) {
    summaries.push({ format, playerCount, outcome: "front", ...simulateTournament(playerCount, format, false, "front") });
    summaries.push({ format, playerCount, outcome: "back", ...simulateTournament(playerCount, format, false, "back") });
  }
  summaries.push({ format, playerCount: 8, reset: true, ...simulateTournament(8, format, true) });
}

const totals = Object.fromEntries(FORMATS.map((format) => [
  format,
  summaries.filter((summary) => summary.format === format && !summary.reset).reduce((sum, summary) => sum + summary.matches, 0),
]));

console.log(`核心对阵验证通过：${summaries.length} 个完整赛事，覆盖 4–16 人、前/后槽优胜及三种赛制。`);
console.log(`累计模拟比赛：duel=${totals.duel}，triple=${totals.triple}，quad=${totals.quad}。`);
console.log("已验证：双败计数、路由完整性、待定槽位、当前/下一局顺序、手动选局、总决赛重赛。");
