import React, { useEffect, useMemo, useRef, useState } from "react";
import TrainingPage from "./TrainingPage.jsx";
import AudienceSkillTreePanel from "./pages/AudienceSkillTreePanel.jsx";
import GroundStationPage from "./pages/GroundStationPage.jsx";
import { TrackAudiencePanel } from "./pages/TrackManagementPage.jsx";
import { clearCoachPassword, setCoachPassword as saveCoachPassword, validateCoachPassword } from "./authConfig.js";
import { videoChannels } from "./trainingShared.js";

const MATCH_W = 272;
const MATCH_H = 128;
const ROUND_GAP = 42;
const BASE_GAP = 14;
const SECTION_GAP = 14;
const FINALS_GAP = 48;
const API_STATE_URL = "/api/state";
const CANVAS_PAN_PADDING = 80;
const AUDIO_WAKEUP_MS = 1000;
const AUDIO_SCHEDULING_LEAD_MS = 80;
const RACE_START_COMPENSATION_MS = 400;
const FALLBACK_AUDIO_OUTPUT_LATENCY_MS =  180;
const FORMAT_OPTIONS = {
  duel: { id: "duel", label: "1V1 双败", heatSize: 2, advanceCount: 1, doubleElimination: true },
  triple: { id: "triple", label: "3 进 2 双败", heatSize: 3, advanceCount: 2, doubleElimination: true },
  quad: { id: "quad", label: "4 进 2 双败", heatSize: 4, advanceCount: 2, doubleElimination: true },
};

function currentTimeMs() {
  return typeof performance !== "undefined" && Number.isFinite(performance.timeOrigin)
    ? performance.timeOrigin + performance.now()
    : Date.now();
}

function audioContextTimeToEpochMs(context, targetContextTime) {
  const outputTimestamp = context.getOutputTimestamp?.();
  if (
    Number.isFinite(outputTimestamp?.contextTime)
    && Number.isFinite(outputTimestamp?.performanceTime)
    && outputTimestamp.performanceTime > 0
  ) {
    return performance.timeOrigin + outputTimestamp.performanceTime
      + (targetContextTime - outputTimestamp.contextTime) * 1000;
  }
  const outputLatency = Math.max(
    Number(context.outputLatency) || 0,
    Number(context.baseLatency) || 0,
    FALLBACK_AUDIO_OUTPUT_LATENCY_MS / 1000,
  );
  return currentTimeMs() + Math.max(0, targetContextTime - context.currentTime) * 1000 + outputLatency * 1000;
}

async function loadSavedState() {
  const response = await fetch(API_STATE_URL, { cache: "no-store" });
  if (!response.ok) throw new Error("读取保存数据失败");
  return response.json();
}

async function saveStateToServer(state) {
  const response = await fetch(API_STATE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  });
  if (!response.ok) throw new Error("保存数据失败");
  return response.json();
}

const styles = {
  page: { minHeight: "100vh", background: "linear-gradient(135deg,#eef2ff,#f8fafc 45%,#fff7ed)", color: "#18181b", padding: 22, fontFamily: "'Microsoft YaHei','微软雅黑',Arial,sans-serif", letterSpacing: 0 },
  container: { maxWidth: 1800, margin: "0 auto", display: "flex", flexDirection: "column", gap: 24 },
  panel: { background: "rgba(255,255,255,.94)", border: "1px solid rgba(228,228,231,.9)", borderRadius: 24, padding: 20, boxShadow: "0 14px 34px rgba(15,23,42,.08)" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" },
  title: { margin: 0, fontSize: 30, fontWeight: 900, letterSpacing: 0 },
  subtitle: { marginTop: 6, color: "#71717a", fontSize: 14, lineHeight: 1.6 },
  controls: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
  select: { height: 38, borderRadius: 12, border: "1px solid #d4d4d8", padding: "0 14px", background: "#fff" ,cursor: "pointer", fontWeight: 700 },
  button: { height: 38, borderRadius: 12, border: "1px solid #d4d4d8", padding: "0 14px", background: "#fff", cursor: "pointer", fontWeight: 700 },
  primaryButton: { background: "#2563eb", color: "#fff", border: "1px solid #2563eb" },
  input: { height: 36, borderRadius: 10, border: "1px solid #d4d4d8", padding: "0 10px", boxSizing: "border-box", width: "100%" },
  playersGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 12 },
  legend: { display: "flex", gap: 12, color: "#52525b", fontSize: 13, flexWrap: "wrap", marginTop: 10, lineHeight: 1.6 },
  legendRows: { display: "flex", flexDirection: "column", gap: 4, color: "#52525b", fontSize: 13, marginTop: 10, lineHeight: 1.6 },
  legendRow: { display: "flex", gap: 12, flexWrap: "wrap" },
  legendStrong: { fontWeight: 900, color: "#111827" },
  zoomBar: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14, flexWrap: "wrap" },
  zoomControls: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  bracketOuter: { width: "100%", height: "calc(100vh - 330px)", minHeight: 520, overflow: "auto", scrollbarWidth: "none", msOverflowStyle: "none", borderRadius: 20, background: "linear-gradient(180deg,#fff,#f8fafc)", border: "1px solid #e4e4e7", position: "relative", userSelect: "none", WebkitUserSelect: "none" },
  bracketPanelFullscreen: { position: "fixed", inset: 0, zIndex: 1000, borderRadius: 0, padding: 18, display: "flex", flexDirection: "column", background: "#fff" },
  bracketOuterFullscreen: { flex: 1, height: "auto", minHeight: 0, borderRadius: 14 },
  bracketCanvas: { position: "relative", transformOrigin: "top left", willChange: "transform", userSelect: "none", WebkitUserSelect: "none" },
  sectionTitle: { position: "absolute", fontSize: 22, fontWeight: 900, color: "#111827", padding: "6px 12px", borderRadius: 999, background: "#eef2ff", border: "1px solid #c7d2fe" },
  match: { position: "absolute", width: MATCH_W, minHeight: MATCH_H, border: "1px solid #e4e4e7", borderRadius: 14, padding: 10, background: "#fff", boxShadow: "0 8px 18px rgba(15,23,42,.08)", boxSizing: "border-box", backfaceVisibility: "hidden", WebkitBackfaceVisibility: "hidden", transform: "translateZ(0)" },
  matchCurrent: { background: "#fff7ed", border: "2px solid #fdba74", boxShadow: "0 0 0 4px rgba(251,146,60,.18)" },
  matchNext: { background: "#eff6ff", border: "2px solid #93c5fd" },
  matchTie: { background: "#fefce8", border: "2px solid #facc15", boxShadow: "0 0 0 4px rgba(250,204,21,.22)" },
  matchTitle: { fontSize: 13, color: "#71717a", marginBottom: 7, display: "flex", justifyContent: "space-between", gap: 8 },
  row: { display: "grid", gridTemplateColumns: "minmax(0,1fr) max-content", gap: 7, alignItems: "center", marginBottom: 7 },
  playerBox: { height: 30, lineHeight: "30px", borderRadius: 9, background: "#fafafa", padding: "0 9px", fontSize: 14, fontWeight: 800, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, maxWidth: "100%", boxSizing: "border-box" },
  resultControls: { display: "grid", gridTemplateColumns: "38px 56px 36px", gap: 2, alignItems: "center" },
  smallInput: { height: 28, borderRadius: 8, border: "1px solid #d4d4d8", textAlign: "center", width: "100%", background: "#fff", boxSizing: "border-box", fontSize: 13, fontWeight: 800 },
  dnfButton: { height: 28, borderRadius: 8, border: "1px solid #d4d4d8", padding: "0 4px", background: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 800 },
  dnfButtonActive: { background: "#fee2e2", border: "1px solid #f87171", color: "#b91c1c", fontWeight: 700 },
  tiePanel: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 4 },
  judgeButton: { minHeight: 38, borderRadius: 8, border: "1px solid #facc15", background: "#fef9c3", color: "#854d0e", cursor: "pointer", fontSize: 12, fontWeight: 800, lineHeight: 1.3, padding: "5px 7px", whiteSpace: "normal", overflowWrap: "anywhere" },
  champion: { borderRadius: 24, background: "linear-gradient(135deg,#ecfdf5,#d1fae5)", color: "#047857", padding: 22, boxShadow: "0 14px 30px rgba(5,150,105,.16)", border: "1px solid #a7f3d0" },
  rankingPanel: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 10, marginTop: 14 },
  rankingItem: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, borderRadius: 14, background: "#f8fafc", border: "1px solid #e2e8f0", padding: "10px 12px", fontSize: 14 },
  rankBadge: { minWidth: 42, height: 26, borderRadius: 999, background: "#e0e7ff", color: "#3730a3", display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: 900 },
  racePanel: { background: "rgba(255,255,255,.94)", color: "#18181b", border: "1px solid rgba(228,228,231,.9)", borderRadius: 24, padding: 20, boxShadow: "0 14px 34px rgba(15,23,42,.08)" },
  timer: { fontSize: 44, lineHeight: 1, fontWeight: 950, color: "#1d4ed8", fontVariantNumeric: "tabular-nums", letterSpacing: 1 },
  lapGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(210px,1fr))", gap: 10, marginTop: 16 },
  lapButton: { width: "100%", minHeight: 58, borderRadius: 14, border: "1px solid #cbd5e1", color: "#0f172a", background: "#f8fafc", cursor: "pointer", padding: "8px 12px", textAlign: "left", fontWeight: 900 },
};

function nextPowerOfTwo(n) { let p = 1; while (p < n) p *= 2; return p; }
function makeId(group, round, index) { return `${group}-${round}-${index}`; }
function blankResult() { return { laps: "", seconds: "", dnf: false }; }
function cloneResult(result) { return result ? { ...result } : blankResult(); }
function clonePlayer(player) {
  if (!player) return null;
  const copy = { ...player };
  if (!copy.pilotId && /^选手\s*\d+$/.test(String(copy.name || ""))) copy.name = "";
  return copy;
}

function createPlayers(count) {
  return Array.from({ length: count }, (_, index) => ({ id: `P${index + 1}`, seed: index + 1, name: "", videoChannel: "" }));
}

function seedOrder(size) {
  if (size === 1) return [1];
  const prev = seedOrder(size / 2);
  return prev.flatMap((seed) => [seed, size + 1 - seed]);
}

function createSeededSlots(players, size) {
  const bySeed = new Map(players.map((player) => [player.seed, player]));
  return seedOrder(size).map((seed) => bySeed.get(seed) || { id: `BYE-${seed}`, seed, name: "BYE", bye: true });
}

function createMatch(group, round, index, titlePrefix, slotCount = 2, advanceCount = 1) {
  const shortTitle = titlePrefix.replace("组", "");
  return {
    id: makeId(group, round, index),
    group,
    round,
    index,
    title: `${shortTitle} ${round + 1}-${index + 1}`,
    slots: Array.from({ length: slotCount }, () => null),
    results: Array.from({ length: slotCount }, blankResult),
    advanceCount,
    winnerTargets: [],
    loserTargets: [],
    advancing: [],
    eliminated: [],
    manualAdvancingSlots: [],
    manualWinnerSlot: null,
    isTie: false,
    winner: null,
    loser: null,
    winnerTarget: null,
    loserTarget: null,
  };
}

function cloneMatch(match) {
  const slots = Array.isArray(match.slots) ? match.slots.map(clonePlayer) : [null, null];
  const resultCount = Math.max(slots.length, Array.isArray(match.results) ? match.results.length : 0);
  return {
    ...match,
    slots,
    results: Array.from({ length: resultCount }, (_, index) => cloneResult(match.results?.[index])),
    winnerTargets: Array.isArray(match.winnerTargets) ? match.winnerTargets.map((target) => ({ ...target })) : [],
    loserTargets: Array.isArray(match.loserTargets) ? match.loserTargets.map((target) => ({ ...target })) : [],
    advancing: Array.isArray(match.advancing) ? match.advancing.map(clonePlayer) : [],
    eliminated: Array.isArray(match.eliminated) ? match.eliminated.map(clonePlayer) : [],
    manualAdvancingSlots: Array.isArray(match.manualAdvancingSlots) ? [...match.manualAdvancingSlots] : [],
    manualWinnerSlot: match.manualWinnerSlot ?? null,
    isTie: Boolean(match.isTie),
    winner: clonePlayer(match.winner),
    loser: clonePlayer(match.loser),
    winnerTarget: match.winnerTarget ? { ...match.winnerTarget } : null,
    loserTarget: match.loserTarget ? { ...match.loserTarget } : null,
  };
}

function createEmptyBracket(playerCount) {
  const safeCount = Math.min(16, Math.max(4, Number(playerCount) || 8));
  const size = nextPowerOfTwo(safeCount);
  const winnerRoundCount = Math.log2(size);
  const loserRoundCount = Math.max(1, winnerRoundCount * 2 - 2);
  const players = createPlayers(safeCount);
  const winners = [];
  const losers = [];

  for (let round = 0; round < winnerRoundCount; round += 1) {
    const matchCount = size / 2 ** (round + 1);
    winners.push(Array.from({ length: matchCount }, (_, index) => createMatch("W", round, index, "胜者组")));
  }

  for (let round = 0; round < loserRoundCount; round += 1) {
    const exponent = Math.floor(round / 2) + 1;
    const matchCount = Math.max(1, size / 2 ** (exponent + 1));
    losers.push(Array.from({ length: matchCount }, (_, index) => createMatch("L", round, index, "败者组")));
  }

  const finals = [
    { id: "GF-0", group: "F", round: 0, index: 0, title: "总决赛", slots: [null, null], results: [blankResult(), blankResult()], manualWinnerSlot: null, isTie: false, winner: null, loser: null, winnerTarget: null, loserTarget: null },
    { id: "GF-1", group: "F", round: 1, index: 0, title: "重赛", slots: [null, null], results: [blankResult(), blankResult()], manualWinnerSlot: null, isTie: false, winner: null, loser: null, winnerTarget: null, loserTarget: null, optional: true },
  ];

  wireRoutes(winners, losers, finals);
  syncFirstRoundPlayers({ format: "duel", size, players, winners });
  const bracket = { format: "duel", size, playerCount: safeCount, players, winners, losers, finals, champion: null };
  normalizeMatchTitles(bracket);
  return bracket;
}

function multiHeatSizes(playerCount, heatSize) {
  const fullHeatCount = Math.floor(playerCount / heatSize);
  const remainder = playerCount % heatSize;
  return [
    ...Array.from({ length: fullHeatCount }, () => heatSize),
    ...(remainder ? [remainder] : []),
  ];
}

function distributeSeededPlayers(players, groupSizes) {
  const groups = groupSizes.map(() => []);
  const ordered = [...players].sort((a, b) => a.seed - b.seed);
  let cursor = 0;
  let direction = 1;
  for (const player of ordered) {
    while (groups[cursor].length >= groupSizes[cursor]) {
      cursor += direction;
      if (cursor >= groups.length) { cursor = groups.length - 1; direction = -1; }
      if (cursor < 0) { cursor = 0; direction = 1; }
    }
    groups[cursor].push(player);
    cursor += direction;
    if (cursor >= groups.length) { cursor = groups.length - 1; direction = -1; }
    if (cursor < 0) { cursor = 0; direction = 1; }
  }
  return groups;
}

function createGrandFinals() {
  return [
    { id: "GF-0", group: "F", round: 0, index: 0, title: "总决赛", slots: [null, null], results: [blankResult(), blankResult()], manualWinnerSlot: null, isTie: false, winner: null, loser: null, winnerTarget: null, loserTarget: null },
    { id: "GF-1", group: "F", round: 1, index: 0, title: "重赛", slots: [null, null], results: [blankResult(), blankResult()], manualWinnerSlot: null, isTie: false, winner: null, loser: null, winnerTarget: null, loserTarget: null, optional: true },
  ];
}

function createMultiRound(group, roundIndex, groupSizes, advanceCount, titlePrefix, eliminationBehavior, heatSize = 0) {
  return groupSizes.map((slotCount, matchIndex) => {
    const displaySlotCount = heatSize || slotCount;
    const match = createMatch(group, roundIndex, matchIndex, titlePrefix, displaySlotCount, Math.min(advanceCount, slotCount));
    match.multi = true;
    match.feedSlotCount = slotCount;
    match.slots = Array.from({ length: displaySlotCount }, (_, slot) => (
      slot < slotCount ? null : { id: `BYE-${match.id}-${slot + 1}`, name: "BYE", bye: true, structuralBye: true }
    ));
    match.eliminationBehavior = eliminationBehavior;
    match.loserTargets = [];
    return match;
  });
}

function outputSources(round, kind) {
  return round.flatMap((match) => {
    const entrantCount = Number(match.feedSlotCount) || match.slots.length;
    const count = kind === "advance" ? match.advanceCount : Math.max(0, entrantCount - match.advanceCount);
    return Array.from({ length: count }, (_, index) => ({ match, kind, index }));
  });
}

function connectSourcesToRound(sources, targetRound) {
  const targetSlots = targetRound.flatMap((match) => (
    match.slots.slice(0, Number(match.feedSlotCount) || match.slots.length).map((_, slot) => ({ matchId: match.id, slot }))
  ));
  sources.forEach((source, index) => {
    const target = targetSlots[index];
    if (!target) return;
    if (source.kind === "drop") source.match.loserTargets[source.index] = target;
    else source.match.winnerTargets[source.index] = target;
  });
}

function createMultiBracket(playerCount, formatId) {
  const safeCount = Math.min(16, Math.max(4, Number(playerCount) || 8));
  const format = FORMAT_OPTIONS[formatId] || FORMAT_OPTIONS.triple;
  const players = createPlayers(safeCount);
  const winners = [];
  const losers = [];
  let undefeatedCount = safeCount;
  let winnerSources = [];
  let lowerSources = [];

  while (undefeatedCount > format.heatSize) {
    const groupSizes = multiHeatSizes(undefeatedCount, format.heatSize);
    const round = createMultiRound("MW", winners.length, groupSizes, format.advanceCount, "胜者组", "drop", format.heatSize);
    if (winnerSources.length) connectSourcesToRound(winnerSources, round);
    winners.push(round);
    winnerSources = outputSources(round, "advance");
    lowerSources.push(...outputSources(round, "drop"));
    undefeatedCount = winnerSources.length;

    if (lowerSources.length > format.advanceCount) {
      const lowerRound = createMultiRound("ML", losers.length, multiHeatSizes(lowerSources.length, format.heatSize), format.advanceCount, "败者组", "eliminate", format.heatSize);
      connectSourcesToRound(lowerSources, lowerRound);
      losers.push(lowerRound);
      lowerSources = outputSources(lowerRound, "advance");
    }
  }

  const winnerFinal = createMultiRound("MW", winners.length, [undefeatedCount], 1, "胜者组决赛", "drop", format.heatSize);
  winnerFinal[0].title = "胜者决赛";
  if (winnerSources.length) connectSourcesToRound(winnerSources, winnerFinal);
  winners.push(winnerFinal);
  const winnerChampionSource = outputSources(winnerFinal, "advance");
  lowerSources.push(...outputSources(winnerFinal, "drop"));

  while (lowerSources.length > format.heatSize) {
    const lowerRound = createMultiRound("ML", losers.length, multiHeatSizes(lowerSources.length, format.heatSize), format.advanceCount, "败者组", "eliminate", format.heatSize);
    connectSourcesToRound(lowerSources, lowerRound);
    losers.push(lowerRound);
    lowerSources = outputSources(lowerRound, "advance");
  }

  const loserFinal = createMultiRound("ML", losers.length, [lowerSources.length], 1, "败者组决赛", "eliminate", format.heatSize);
  loserFinal[0].title = "败者决赛";
  connectSourcesToRound(lowerSources, loserFinal);
  losers.push(loserFinal);
  const loserChampionSource = outputSources(loserFinal, "advance");
  const finals = createGrandFinals();
  winnerChampionSource[0].match.winnerTargets[0] = { matchId: finals[0].id, slot: 0 };
  loserChampionSource[0].match.winnerTargets[0] = { matchId: finals[0].id, slot: 1 };

  const firstGroups = distributeSeededPlayers(players, winners[0].map((match) => match.feedSlotCount || match.slots.length));
  winners[0].forEach((match, index) => {
    const feedSlotCount = match.feedSlotCount || match.slots.length;
    match.slots = [...firstGroups[index].map(clonePlayer), ...match.slots.slice(feedSlotCount).map(clonePlayer)];
  });

  return {
    format: format.id,
    doubleEliminationMulti: true,
    size: safeCount,
    playerCount: safeCount,
    players,
    winners,
    losers,
    finals,
    champion: null,
  };
}

function createTournament(playerCount, formatId = "duel") {
  return formatId === "duel" ? createEmptyBracket(playerCount) : createMultiBracket(playerCount, formatId);
}

function wireRoutes(winners, losers, finals) {
  for (let round = 0; round < winners.length; round += 1) {
    for (const match of winners[round]) {
      match.winnerTarget = round + 1 < winners.length
        ? { matchId: winners[round + 1][Math.floor(match.index / 2)].id, slot: match.index % 2 }
        : { matchId: finals[0].id, slot: 0 };

      const loserRoundIndex = round === 0 ? 0 : 2 * round - 1;
      const loserRound = losers[loserRoundIndex];
      if (!loserRound) continue;
      if (round === 0) {
        match.loserTarget = { matchId: loserRound[Math.floor(match.index / 2)].id, slot: match.index % 2 };
      } else {
        const targetIndex = loserRound.length - 1 - Math.min(match.index, loserRound.length - 1);
        match.loserTarget = { matchId: loserRound[targetIndex].id, slot: 1 };
      }
    }
  }

  for (let round = 0; round < losers.length; round += 1) {
    for (const match of losers[round]) {
      const nextRound = losers[round + 1];
      if (!nextRound) match.winnerTarget = { matchId: finals[0].id, slot: 1 };
      else if (nextRound.length === losers[round].length) match.winnerTarget = { matchId: nextRound[match.index].id, slot: 0 };
      else match.winnerTarget = { matchId: nextRound[Math.floor(match.index / 2)].id, slot: match.index % 2 };
    }
  }
}

function cloneBracket(raw) {
  return {
    ...raw,
    format: raw.format || "duel",
    players: (raw.players || []).map(clonePlayer),
    winners: (raw.winners || []).map((round) => round.map(cloneMatch)),
    losers: (raw.losers || []).map((round) => round.map(cloneMatch)),
    finals: (raw.finals || []).map(cloneMatch),
    champion: clonePlayer(raw.champion),
  };
}

function allMatches(bracket) { return [...bracket.winners.flat(), ...bracket.losers.flat(), ...bracket.finals]; }
function findMatch(bracket, matchId) { return allMatches(bracket).find((match) => match.id === matchId); }

function repairBracketShape(raw) {
  const bracket = cloneBracket(raw);
  if (bracket.format !== "duel") {
    if (!bracket.doubleEliminationMulti) {
      const rebuilt = createMultiBracket(bracket.playerCount || bracket.players.length || 8, bracket.format);
      const storedPlayers = new Map(bracket.players.map((player) => [player.id, player]));
      rebuilt.players = rebuilt.players.map((player) => ({ ...player, ...(storedPlayers.get(player.id) || {}) }));
      syncFirstRoundPlayers(rebuilt);
      normalizeMatchTitles(rebuilt);
      return rebuilt;
    }
    const heatSize = FORMAT_OPTIONS[bracket.format]?.heatSize || 2;
    allMatches(bracket).filter((match) => match.multi).forEach((match) => {
      const feedSlotCount = Math.min(heatSize, Math.max(1, Number(match.feedSlotCount) || match.slots.length));
      match.feedSlotCount = feedSlotCount;
      while (match.slots.length < heatSize) {
        const slot = match.slots.length;
        match.slots.push({ id: `BYE-${match.id}-${slot + 1}`, name: "BYE", bye: true, structuralBye: true });
      }
      while (match.results.length < match.slots.length) match.results.push(blankResult());
    });
    normalizeMatchTitles(bracket);
    return bracket;
  }
  allMatches(bracket).forEach((match) => {
    match.slots = Array.from({ length: 2 }, (_, index) => clonePlayer(match.slots[index]));
    match.results = Array.from({ length: 2 }, (_, index) => cloneResult(match.results[index]));
  });
  syncFirstRoundPlayers(bracket);
  normalizeMatchTitles(bracket);
  return bracket;
}

function normalizeMatchTitles(bracket) {
  bracket.winners.forEach((round, roundIndex) => round.forEach((match, matchIndex) => {
    match.title = roundIndex === bracket.winners.length - 1 ? "胜者决赛" : `胜者 ${roundIndex + 1}-${matchIndex + 1}`;
  }));
  bracket.losers.forEach((round, roundIndex) => round.forEach((match, matchIndex) => {
    match.title = roundIndex === bracket.losers.length - 1 ? "败者决赛" : `败者 ${roundIndex + 1}-${matchIndex + 1}`;
  }));
  if (bracket.finals[0]) bracket.finals[0].title = "总决赛";
  if (bracket.finals[1]) bracket.finals[1].title = "重赛";
}

function syncFirstRoundPlayers(bracket) {
  if ((bracket.format || "duel") !== "duel") {
    const firstRound = bracket.winners[0] || bracket.finals;
    const groups = distributeSeededPlayers(bracket.players, firstRound.map((match) => match.feedSlotCount || match.slots.length));
    firstRound.forEach((match, index) => {
      const feedSlotCount = match.feedSlotCount || match.slots.length;
      match.slots = [...groups[index].map(clonePlayer), ...match.slots.slice(feedSlotCount).map(clonePlayer)];
    });
    return;
  }
  const seededSlots = createSeededSlots(bracket.players, bracket.size);
  for (let index = 0; index < bracket.winners[0].length; index += 1) {
    bracket.winners[0][index].slots = [seededSlots[index * 2], seededSlots[index * 2 + 1]];
  }
}

function clearGeneratedSlots(bracket) {
  if (bracket.format !== "duel") {
    bracket.winners.forEach((round, roundIndex) => round.forEach((match) => {
      if (roundIndex > 0) {
        const feedSlotCount = Number(match.feedSlotCount) || match.slots.length;
        match.slots = match.slots.map((player, index) => (index < feedSlotCount ? null : clonePlayer(player)));
      }
      match.winner = null;
      match.loser = null;
      match.advancing = [];
      match.eliminated = [];
      match.isTie = false;
    }));
    bracket.losers.forEach((round) => round.forEach((match) => {
      const feedSlotCount = Number(match.feedSlotCount) || match.slots.length;
      match.slots = match.slots.map((player, index) => (index < feedSlotCount ? null : clonePlayer(player)));
      match.winner = null;
      match.loser = null;
      match.advancing = [];
      match.eliminated = [];
      match.isTie = false;
    }));
    bracket.finals.forEach((match) => {
      match.slots = [null, null];
      match.winner = null;
      match.loser = null;
      match.isTie = false;
    });
    bracket.champion = null;
    return;
  }
  for (let round = 1; round < bracket.winners.length; round += 1) {
    bracket.winners[round].forEach((match) => { match.slots = [null, null]; match.winner = null; match.loser = null; match.isTie = false; });
  }
  bracket.losers.forEach((round) => round.forEach((match) => { match.slots = [null, null]; match.winner = null; match.loser = null; match.isTie = false; }));
  bracket.finals.forEach((match) => { match.slots = [null, null]; match.winner = null; match.loser = null; match.isTie = false; });
  bracket.champion = null;
}

function setSlotByTarget(bracket, target, player) {
  if (!target || !player) return;
  const targetMatch = findMatch(bracket, target.matchId);
  if (targetMatch) targetMatch.slots[target.slot] = clonePlayer(player);
}

function matchRouteTargets(match) {
  return [
    ...(match.winnerTargets || []),
    ...(match.loserTargets || []),
    ...(match.winnerTarget ? [match.winnerTarget] : []),
    ...(match.loserTarget ? [match.loserTarget] : []),
    ...(match.id === "GF-0" ? [{ matchId: "GF-1", slot: 0 }] : []),
  ];
}

function clearStoredMatchResult(match) {
  match.results = match.slots.map(() => blankResult());
  match.manualWinnerSlot = null;
  match.manualAdvancingSlots = [];
  match.winner = null;
  match.loser = null;
  match.advancing = [];
  match.eliminated = [];
  match.isTie = false;
}

function clearDownstreamResults(bracket, startMatchId, includeStart = false) {
  const visited = new Set();
  const queue = [startMatchId];
  while (queue.length) {
    const matchId = queue.shift();
    if (!matchId || visited.has(matchId)) continue;
    visited.add(matchId);
    const match = findMatch(bracket, matchId);
    if (!match) continue;
    if (includeStart || matchId !== startMatchId) clearStoredMatchResult(match);
    matchRouteTargets(match).forEach((target) => queue.push(target.matchId));
  }
}

function makeStructuralBye(sourceMatch, target) { return { id: `LB-BYE-${sourceMatch.id}-${target.matchId}-${target.slot}`, name: "BYE", bye: true, structuralBye: true }; }
function makeAdvanceBye(sourceMatch, target) { return { id: `ADV-BYE-${sourceMatch.id}-${target.matchId}-${target.slot}`, name: "BYE", bye: true, structuralBye: true }; }
function isRealPlayer(player) { return Boolean(player && !player.bye); }
function matchHasRealVsBye(match) { const [a, b] = match.slots; return Boolean(a && b && ((a.bye && !b.bye) || (b.bye && !a.bye))); }
function matchHasByeVsBye(match) { const [a, b] = match.slots; return Boolean(a && b && a.bye && b.bye); }
function hasAnyResultInput(result) { return Boolean(result?.dnf || result?.laps !== "" || result?.seconds !== ""); }

function normalizeResult(result) {
  if (result?.timerInProgress) return { complete: false };
  const dnf = Boolean(result?.dnf);
  const laps = dnf ? null : Number(result?.laps);
  const seconds = dnf ? null : Number(result?.seconds);
  if (dnf) return { complete: true, dnf: true, laps: -1, seconds: Infinity };
  if (!Number.isInteger(laps) || laps < 0 || laps > 3) return { complete: false };
  if (laps === 0) return { complete: true, dnf: false, laps: 0, seconds: 0 };
  if (result?.seconds === "" || Number.isNaN(seconds) || seconds < 0) return { complete: false };
  return { complete: true, dnf: false, laps, seconds };
}

function compareResults(resultA, resultB) {
  if (!hasAnyResultInput(resultA) || !hasAnyResultInput(resultB)) return { status: "incomplete", value: 0 };
  const a = normalizeResult(resultA);
  const b = normalizeResult(resultB);
  if (!a.complete || !b.complete) return { status: "incomplete", value: 0 };
  if (a.dnf && b.dnf) return { status: "tie", value: 0 };
  if (a.dnf && !b.dnf) return { status: "decided", value: -1 };
  if (!a.dnf && b.dnf) return { status: "decided", value: 1 };
  if (a.laps !== b.laps) return { status: "decided", value: a.laps > b.laps ? 1 : -1 };
  if (a.seconds !== b.seconds) return { status: "decided", value: a.seconds < b.seconds ? 1 : -1 };
  return { status: "tie", value: 0 };
}

function compareNormalizedResults(a, b) {
  if (a.dnf !== b.dnf) return a.dnf ? 1 : -1;
  if (a.dnf && b.dnf) return 0;
  if (a.laps !== b.laps) return b.laps - a.laps;
  return a.seconds - b.seconds;
}

function resolveMultiResult(match) {
  const feedSlotCount = Number(match.feedSlotCount) || match.slots.length;
  const allFeedSlotsResolved = match.slots.slice(0, feedSlotCount).every(Boolean);
  const entries = match.slots
    .map((player, slot) => ({ player, slot, result: normalizeResult(match.results[slot]) }))
    .filter((entry) => isRealPlayer(entry.player));
  const advanceCount = Math.min(Number(match.advanceCount) || 1, entries.length);
  match.isTie = false;
  if (!allFeedSlotsResolved) return { advancing: [], eliminated: [] };
  if (!entries.length) return { advancing: [], eliminated: [] };
  if (entries.length <= advanceCount) return { advancing: entries.map((entry) => entry.player), eliminated: [] };
  if (entries.some((entry) => !hasAnyResultInput(match.results[entry.slot]) || !entry.result.complete)) {
    return { advancing: [], eliminated: [] };
  }

  const sorted = [...entries].sort((a, b) => compareNormalizedResults(a.result, b.result));
  const cutoffTie = compareNormalizedResults(sorted[advanceCount - 1].result, sorted[advanceCount].result) === 0;
  if (cutoffTie) {
    match.isTie = true;
    const manualSlots = Array.isArray(match.manualAdvancingSlots) ? match.manualAdvancingSlots : [];
    const manual = entries.filter((entry) => manualSlots.includes(entry.slot));
    if (manual.length !== advanceCount) return { advancing: [], eliminated: [] };
    const selected = new Set(manual.map((entry) => entry.slot));
    return {
      advancing: manual.map((entry) => entry.player),
      eliminated: sorted.filter((entry) => !selected.has(entry.slot)).map((entry) => entry.player),
    };
  }
  match.manualAdvancingSlots = [];
  return {
    advancing: sorted.slice(0, advanceCount).map((entry) => entry.player),
    eliminated: sorted.slice(advanceCount).map((entry) => entry.player),
  };
}

function resolveResult(match) {
  const [a, b] = match.slots;
  match.isTie = false;
  if (!a || !b) return { winner: null, loser: null };
  if (a.bye && b.bye) return { winner: null, loser: null };
  if (a.bye && !b.bye) return { winner: b, loser: null };
  if (b.bye && !a.bye) return { winner: a, loser: null };

  const comparison = compareResults(match.results[0], match.results[1]);
  if (comparison.status === "incomplete") return { winner: null, loser: null };
  if (comparison.status === "tie") {
    match.isTie = true;
    if (match.manualWinnerSlot === 0) return { winner: a, loser: b };
    if (match.manualWinnerSlot === 1) return { winner: b, loser: a };
    return { winner: null, loser: null };
  }
  match.manualWinnerSlot = null;
  return comparison.value > 0 ? { winner: a, loser: b } : { winner: b, loser: a };
}

function applyMatchResult(bracket, match) {
  const result = resolveResult(match);
  match.winner = result.winner;
  match.loser = result.loser;
  if (result.winner) setSlotByTarget(bracket, match.winnerTarget, result.winner);
  else if (match.winnerTarget && matchHasByeVsBye(match)) setSlotByTarget(bracket, match.winnerTarget, makeAdvanceBye(match, match.winnerTarget));
  if (result.loser) setSlotByTarget(bracket, match.loserTarget, result.loser);
  else if (result.winner && match.loserTarget && matchHasRealVsBye(match)) setSlotByTarget(bracket, match.loserTarget, makeStructuralBye(match, match.loserTarget));
}

function applyMultiMatchResult(bracket, match) {
  const result = resolveMultiResult(match);
  match.advancing = result.advancing;
  match.eliminated = result.eliminated;
  match.winner = result.advancing[0] || null;
  match.loser = result.eliminated[0] || null;
  result.advancing.forEach((player, index) => setSlotByTarget(bracket, match.winnerTargets?.[index], player));
  if (match.eliminationBehavior === "drop") {
    result.eliminated.forEach((player, index) => setSlotByTarget(bracket, match.loserTargets?.[index], player));
  }
}

function recomputeMultiBracket(raw, shouldAnnotate = true) {
  const bracket = cloneBracket(raw);
  clearGeneratedSlots(bracket);
  syncFirstRoundPlayers(bracket);
  bracket.winners.forEach((round) => round.forEach((match) => applyMultiMatchResult(bracket, match)));
  bracket.losers.forEach((round) => round.forEach((match) => applyMultiMatchResult(bracket, match)));

  const grandFinal = bracket.finals[0];
  const grandResult = resolveResult(grandFinal);
  grandFinal.winner = grandResult.winner;
  grandFinal.loser = grandResult.loser;
  if (grandFinal.winner) {
    const wbChampion = grandFinal.slots[0];
    if (grandFinal.winner.id === wbChampion?.id) bracket.champion = grandFinal.winner;
    else {
      bracket.finals[1].slots = [grandFinal.winner, grandFinal.loser];
      const resetResult = resolveResult(bracket.finals[1]);
      bracket.finals[1].winner = resetResult.winner;
      bracket.finals[1].loser = resetResult.loser;
      if (resetResult.winner) bracket.champion = resetResult.winner;
    }
  }
  if (shouldAnnotate) annotateMatchHighlights(bracket);
  return bracket;
}

function recomputeBracket(raw, shouldAnnotate = true) {
  if ((raw.format || "duel") !== "duel") return recomputeMultiBracket(raw, shouldAnnotate);
  const bracket = cloneBracket(raw);
  clearGeneratedSlots(bracket);
  syncFirstRoundPlayers(bracket);
  bracket.winners.forEach((round) => round.forEach((match) => applyMatchResult(bracket, match)));
  bracket.losers.forEach((round) => round.forEach((match) => applyMatchResult(bracket, match)));

  const grandFinal = bracket.finals[0];
  const grandResult = resolveResult(grandFinal);
  grandFinal.winner = grandResult.winner;
  grandFinal.loser = grandResult.loser;
  if (grandFinal.winner) {
    const wbChampion = grandFinal.slots[0];
    if (grandFinal.winner.id === wbChampion?.id) bracket.champion = grandFinal.winner;
    else {
      bracket.finals[1].slots = [grandFinal.winner, grandFinal.loser];
      const resetResult = resolveResult(bracket.finals[1]);
      bracket.finals[1].winner = resetResult.winner;
      bracket.finals[1].loser = resetResult.loser;
      if (resetResult.winner) bracket.champion = resetResult.winner;
    }
  }
  if (shouldAnnotate) annotateMatchHighlights(bracket);
  return bracket;
}

function isMultiMatch(match) { return Boolean(match.multi); }

function isMatchComplete(match) {
  if (isMultiMatch(match)) return Boolean(match.advancing?.length);
  return Boolean(match.winner);
}

function isPlayableMatch(match) {
  if (isMultiMatch(match)) {
    const realPlayers = match.slots.filter(isRealPlayer);
    const feedSlotCount = Number(match.feedSlotCount) || match.slots.length;
    return Boolean(realPlayers.length > (Number(match.advanceCount) || 1) && realPlayers.length === feedSlotCount && !match.advancing?.length);
  }
  const [a, b] = match.slots;
  return Boolean(isRealPlayer(a) && isRealPlayer(b) && !match.winner);
}
function clearHighlights(bracket) { allMatches(bracket).forEach((match) => { match.highlight = null; }); }

function bracketOrderMatches(bracket) {
  const ordered = [];
  const maxRounds = Math.max(bracket.winners.length, bracket.losers.length);
  for (let i = 0; i < maxRounds; i += 1) {
    if (bracket.winners[i]) ordered.push(...bracket.winners[i]);
    if (bracket.losers[i]) ordered.push(...bracket.losers[i]);
  }
  ordered.push(...bracket.finals);
  return ordered;
}

function getPlayableQueue(bracket) { return bracketOrderMatches(bracket).filter(isPlayableMatch); }
function getSingleCurrentMatch(bracket, selectedMatchId = "") {
  return (selectedMatchId ? findMatch(bracket, selectedMatchId) : null) || getPlayableQueue(bracket)[0] || null;
}

function finalizeMatchResults(match, elapsedMs = 0) {
  const fallbackSeconds = (Math.max(0, Number(elapsedMs) || 0) / 1000).toFixed(2);
  match.results = match.slots.map((player, index) => {
    if (!isRealPlayer(player)) return blankResult();
    const result = cloneResult(match.results[index]);
    if (result.dnf) return { laps: "", seconds: "", dnf: true, timerInProgress: false };
    if (!hasAnyResultInput(result)) return { laps: "", seconds: "", dnf: true, timerInProgress: false };
    const laps = Number(result.laps);
    const seconds = result.seconds === "" && Number.isInteger(laps) && laps > 0 ? fallbackSeconds : result.seconds;
    return { ...result, seconds: String(seconds), timerInProgress: false };
  });

  if (isMultiMatch(match)) resolveMultiResult(match);
  else resolveResult(match);
  return match;
}

function finishBracketMatch(rawBracket, matchId, elapsedMs = 0) {
  const nextRaw = cloneBracket(rawBracket);
  const computedBeforeFinish = recomputeBracket(nextRaw, false);
  const visibleMatch = findMatch(computedBeforeFinish, matchId);
  const storedMatch = findMatch(nextRaw, matchId);
  if (!visibleMatch || !storedMatch) return { rawBracket, computedBracket: computedBeforeFinish, finishedMatch: null, nextMatch: null };

  clearDownstreamResults(nextRaw, matchId);
  const finalized = finalizeMatchResults(cloneMatch(visibleMatch), elapsedMs);
  storedMatch.results = finalized.results.map(cloneResult);
  storedMatch.manualWinnerSlot = finalized.manualWinnerSlot ?? null;
  storedMatch.manualAdvancingSlots = [...(finalized.manualAdvancingSlots || [])];

  const computedBracket = recomputeBracket(nextRaw, false);
  const finishedMatch = findMatch(computedBracket, matchId);
  const nextMatch = finishedMatch && isMatchComplete(finishedMatch) ? getPlayableQueue(computedBracket)[0] || null : null;
  return { rawBracket: nextRaw, computedBracket, finishedMatch, nextMatch };
}

function projectNextMatch(bracket, matchId) {
  const finished = finishBracketMatch(bracket, matchId);
  if (finished.nextMatch) return finished.nextMatch;
  if (!finished.finishedMatch?.isTie) return null;

  const projectedRaw = cloneBracket(finished.rawBracket);
  const projectedMatch = findMatch(projectedRaw, matchId);
  const visibleMatch = finished.finishedMatch;
  if (!projectedMatch || !visibleMatch) return null;
  const decisiveProjection = cloneMatch(visibleMatch);
  setProjectedMatchResult(decisiveProjection);
  projectedMatch.results = decisiveProjection.results.map(cloneResult);
  projectedMatch.manualWinnerSlot = null;
  projectedMatch.manualAdvancingSlots = [];
  return getPlayableQueue(recomputeBracket(projectedRaw, false))[0] || null;
}

function setProjectedMatchResult(match, preferSecond = false) {
  match.results = match.slots.map((player, index) => {
    if (!isRealPlayer(player)) return blankResult();
    const rank = preferSecond && match.slots.length === 2 ? (index === 1 ? 0 : 1) : index;
    return { laps: "3", seconds: String(10 + rank), dnf: false, timerInProgress: false };
  });
  match.manualWinnerSlot = null;
  match.manualAdvancingSlots = [];
}

function annotateMatchHighlights(bracket, selectedMatchId = "") {
  clearHighlights(bracket);
  const current = getSingleCurrentMatch(bracket, selectedMatchId);
  const projectedNext = current ? projectNextMatch(bracket, current.id) : null;
  const next = projectedNext ? findMatch(bracket, projectedNext.id) : null;
  if (current) current.highlight = "current";
  if (next) next.highlight = "next1";
}

function simulateTournamentMatchCount(playerCount, formatId, forceGrandFinalReset = false) {
  let raw = createTournament(playerCount, formatId);
  let raceCount = 0;
  for (let guard = 0; guard < 200; guard += 1) {
    const computed = recomputeBracket(raw, false);
    if (computed.champion) return raceCount;
    const current = getPlayableQueue(computed)[0];
    if (!current) return raceCount;
    raw = cloneBracket(computed);
    const rawCurrent = findMatch(raw, current.id);
    setProjectedMatchResult(rawCurrent, forceGrandFinalReset && current.id === "GF-0");
    raceCount += 1;
  }
  return raceCount;
}

function getTournamentMatchCount(playerCount, formatId) {
  const normal = simulateTournamentMatchCount(playerCount, formatId, false);
  const withReset = simulateTournamentMatchCount(playerCount, formatId, true);
  return { normal, withReset: Math.max(normal, withReset) };
}

function getMatchHighlightStyle(match) {
  if (match.isTie && !isMatchComplete(match)) return styles.matchTie;
  if (match.highlight === "current") return styles.matchCurrent;
  if (match.highlight === "next1") return styles.matchNext;
  return {};
}

function getEliminationRecords(bracket) {
  const records = [];
  let order = 0;
  for (const match of bracketOrderMatches(bracket)) {
    if (bracket.format !== "duel") {
      const isLowerElimination = match.multi && match.eliminationBehavior === "eliminate";
      if (isLowerElimination) for (const player of match.eliminated || []) {
        order += 1;
        records.push({ player, order, matchTitle: match.title });
      }
      if (match.group === "F" && match.loser && !match.loser.bye) {
        const resetRequired = match.id === "GF-0" && match.winner?.id !== match.slots[0]?.id;
        if (!resetRequired) {
          order += 1;
          records.push({ player: match.loser, order, matchTitle: match.title });
        }
      }
      continue;
    }
    if (!match.loser || match.loser.bye || match.group === "W") continue;
    order += 1;
    records.push({ player: match.loser, order, matchTitle: match.title });
  }
  return records;
}

function getRankings(bracket) {
  const total = bracket.players.length;
  const latestLossByPlayer = new Map();
  getEliminationRecords(bracket).forEach((record) => latestLossByPlayer.set(record.player.id, record));
  const finalRankByPlayer = new Map();
  Array.from(latestLossByPlayer.values()).sort((a, b) => a.order - b.order).forEach((record, index) => {
    finalRankByPlayer.set(record.player.id, { rank: total - index, status: `淘汰于 ${record.matchTitle}` });
  });
  if (bracket.champion) finalRankByPlayer.set(bracket.champion.id, { rank: 1, status: "冠军" });
  return bracket.players.filter((player) => String(player?.name || "").trim()).map((player) => {
    const finalized = finalRankByPlayer.get(player.id);
    return finalized ? { rank: finalized.rank, player, status: finalized.status } : { rank: "未定", player, status: "仍在比赛中" };
  }).sort((a, b) => {
    if (a.rank === "未定" && b.rank === "未定") return a.player.seed - b.player.seed;
    if (a.rank === "未定") return 1;
    if (b.rank === "未定") return -1;
    return a.rank - b.rank;
  });
}

function getPlayerTextStyle(match, player) {
  if (!player || player.bye) return { color: "#a1a1aa" };
  if (match.advancing?.some((item) => item.id === player.id)) return { color: "#047857", fontWeight: 700 };
  if (match.eliminated?.some((item) => item.id === player.id)) {
    return match.eliminationBehavior === "drop"
      ? { color: "#b45309", fontWeight: 700 }
      : { color: "#71717a", textDecoration: "line-through" };
  }
  if (match.winner?.id === player.id) return { color: "#047857", fontWeight: 700 };
  if (match.loser?.id === player.id) return { color: "#71717a", textDecoration: "line-through" };
  return { color: "#18181b" };
}

function playerDisplayName(player) {
  if (!player) return "待定";
  if (!String(player.name || "").trim()) return "空位";
  return player.videoChannel ? `${player.name} · ${player.videoChannel}` : player.name;
}

function matchTiePanelHeight(match) {
  if (!match?.isTie || isMatchComplete(match)) return 0;
  return Math.ceil((match.slots?.length || 0) / 2) * 42 + 4;
}

function matchCardHeight(match) {
  return Math.max(MATCH_H, 52 + match.slots.length * 37 + matchTiePanelHeight(match));
}

function LiveStatusBadge() {
  return (
    <span className="live-status-badge" aria-label="进行中">
      <span className="live-status-dot" aria-hidden="true" />
      进行中
    </span>
  );
}

function ResultControls({ result = blankResult(), disabled, onChange }) {
  const dnf = Boolean(result.dnf);
  const laps = dnf ? "" : result.laps;
  const seconds = dnf ? "" : result.seconds;
  return (
    <div style={styles.resultControls}>
      <select disabled={disabled || dnf} value={laps} onChange={(e) => onChange({ ...result, laps: e.target.value, seconds: e.target.value === "0" ? "0" : result.seconds, timerInProgress: false })} style={{ ...styles.smallInput, opacity: disabled || dnf ? 0.45 : 1 }} title="圈数">
        <option value="">圈</option><option value="0">0</option><option value="1">1</option><option value="2">2</option><option value="3">3</option>
      </select>
      <input disabled={disabled || dnf || result.laps === "0"} value={result.laps === "0" ? "0" : seconds} onChange={(e) => { if (/^\d*(\.\d*)?$/.test(e.target.value)) onChange({ ...result, seconds: e.target.value, timerInProgress: false }); }} placeholder="秒" style={{ ...styles.smallInput, opacity: disabled || dnf || result.laps === "0" ? 0.45 : 1 }} inputMode="decimal" title="秒数" />
      <button type="button" disabled={disabled} onClick={() => onChange(dnf ? blankResult() : { laps: "", seconds: "", dnf: true })} style={{ ...styles.dnfButton, ...(dnf ? styles.dnfButtonActive : {}), opacity: disabled ? 0.45 : 1 }}>DNF</button>
    </div>
  );
}

const MatchCard = React.memo(function MatchCard({ match, x, y, onResultChange, onManualWinner, onSelectCurrent, canEdit }) {
  const isMulti = isMultiMatch(match);
  const realPlayers = match.slots.filter(isRealPlayer);
  const hasPendingPlayer = match.slots.some((player) => !player || (!player.bye && !String(player.name || "").trim()));
  const disabled = !canEdit || hasPendingPlayer || realPlayers.length <= (Number(match.advanceCount) || 1);
  const manualSlots = match.manualAdvancingSlots || [];
  const cardHeight = matchCardHeight(match);
  return (
    <div
      data-no-pan="true"
      className={match.highlight === "current" ? "bracket-match-current" : undefined}
      title={canEdit ? (hasPendingPlayer ? "选手待定，不能手动切换" : "双击手动调整本局") : undefined}
      onDoubleClick={() => canEdit && !hasPendingPlayer && onSelectCurrent?.(match)}
      style={{ ...styles.match, ...getMatchHighlightStyle(match), left: x, top: y, height: cardHeight }}
    >
      <div style={styles.matchTitle}>
        <span>{match.title}</span>
        {match.highlight === "current" && <span style={{ color: "#ea580c", fontWeight: 900 }}>当前</span>}
        {match.highlight === "next1" && <span style={{ color: "#2563eb", fontWeight: 900 }}>下一场</span>}
      </div>
      {match.slots.map((player, index) => (
        <div key={`${match.id}-${index}`} style={{ ...styles.row, minWidth: 0 }}>
          <div title={playerDisplayName(player)} style={{ ...styles.playerBox, ...getPlayerTextStyle(match, player) }}>{playerDisplayName(player)}</div>
          <ResultControls result={match.results[index]} disabled={disabled} onChange={(nextResult) => onResultChange(match.id, index, nextResult)} />
        </div>
      ))}
      {canEdit && match.isTie && !isMatchComplete(match) && (
        <div style={{ ...styles.tiePanel, gridTemplateColumns: `repeat(${Math.min(match.slots.length, 2)},minmax(0,1fr))` }}>
          {match.slots.map((player, index) => isRealPlayer(player) ? (
            <button
              key={player.id}
              type="button"
              style={{ ...styles.judgeButton, ...(manualSlots.includes(index) ? { background: "#facc15", color: "#422006" } : {}) }}
              onClick={() => onManualWinner(match.id, index)}
            >{isMulti ? `选 ${player.name}` : `判 ${player.name} 胜`}</button>
          ) : null)}
        </div>
      )}
    </div>
  );
});

function layoutRounds(rounds, mode, offsetX, offsetY) {
  const positions = new Map();
  let height = 0;
  rounds.forEach((round, roundIndex) => {
    const x = offsetX + roundIndex * (MATCH_W + ROUND_GAP);
    const spreadPower = mode === "winner" ? roundIndex : Math.floor(roundIndex / 2);
    const roundMatchHeight = Math.max(MATCH_H, ...round.map(matchCardHeight));
    const block = roundMatchHeight + BASE_GAP + spreadPower * 10;
    height = Math.max(height, round.length * block);
    round.forEach((match, matchIndex) => positions.set(match.id, { x, y: offsetY + matchIndex * block + spreadPower * 18, w: MATCH_W, h: matchCardHeight(match), match }));
  });
  return { positions, width: rounds.length * MATCH_W + Math.max(0, rounds.length - 1) * ROUND_GAP, height: Math.max(height + 50, 240) };
}

function layoutFinals(finals, offsetX, offsetY) {
  const positions = new Map();
  let y = offsetY;
  finals.forEach((match) => {
    const height = matchCardHeight(match);
    positions.set(match.id, { x: offsetX, y, w: MATCH_W, h: height, match });
    y += height + 36;
  });
  return { positions, width: MATCH_W, height: Math.max(0, y - offsetY) + 24 };
}

function connectorPath(from, to, slot = 0) {
  const x1 = from.x + from.w;
  const y1 = from.y + from.h / 2;
  const x2 = to.x;
  const targetSlotCount = Math.max(2, to.match?.slots?.length || 2);
  const y2 = to.y + to.h * ((slot + 1) / (targetSlotCount + 1));
  const midX = x1 + Math.max(30, (x2 - x1) / 2);
  return `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
}

function buildUnifiedLayout(bracket) {
  const titleH = 40;
  const winnerLayout = layoutRounds(bracket.winners, "winner", 0, titleH);
  const loserOffsetY = titleH + winnerLayout.height + SECTION_GAP;
  const loserLayout = layoutRounds(bracket.losers, "loser", 0, loserOffsetY + titleH);
  const leftWidth = Math.max(winnerLayout.width, loserLayout.width);
  const finalsX = leftWidth + FINALS_GAP;
  const finalsY = titleH + Math.max(40, (winnerLayout.height + loserLayout.height) / 2 - MATCH_H);
  const finalsLayout = layoutFinals(bracket.finals, finalsX, finalsY);
  const positions = new Map([...winnerLayout.positions, ...loserLayout.positions, ...finalsLayout.positions]);
  return {
    positions,
    width: finalsX + finalsLayout.width + 60,
    height: loserOffsetY + titleH + loserLayout.height + 40,
    titles: [{ text: "胜者组", x: 0, y: 0 }, { text: "败者组", x: 0, y: loserOffsetY }, { text: "总决赛", x: finalsX, y: finalsY - 44 }],
  };
}

function RankingBoard({ rankings }) {
  return (
    <section style={styles.panel}>
      <h2 style={{ marginTop: 0 }}>实时排名</h2>
      <div style={styles.rankingPanel}>
        {rankings.map((item) => (
          <div key={item.player.id} style={styles.rankingItem}>
            <span style={styles.rankBadge}>{item.rank}</span>
            <strong style={{ flex: 1 }}>{playerDisplayName(item.player)}</strong>
            <span style={{ color: item.status === "冠军" ? "#047857" : "#64748b", fontSize: 12 }}>{item.status}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function formatRaceTime(ms) {
  const total = Math.max(0, Number(ms) || 0);
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const hundredths = Math.floor((total % 1000) / 10);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(hundredths).padStart(2, "0")}`;
}

function createRaceState(matchId = "") {
  return { matchId, phase: "ready", scheduledStartAt: 0, startedAt: 0, elapsedMs: 0 };
}

function normalizeRaceState(value) {
  const phase = ["ready", "countdown", "running", "stopped"].includes(value?.phase) ? value.phase : "ready";
  return {
    matchId: value?.matchId || "",
    phase,
    scheduledStartAt: Number(value?.scheduledStartAt) || 0,
    startedAt: Number(value?.startedAt) || 0,
    elapsedMs: Math.max(0, Number(value?.elapsedMs) || 0),
  };
}

function RaceControlCard({ match, onRecordLap, onFinishMatch, raceState, onRaceStateChange, canEdit }) {
  const activeState = raceState?.matchId === match?.id ? normalizeRaceState(raceState) : createRaceState(match?.id || "");
  const phase = activeState.phase;
  const [clockNow, setClockNow] = useState(() => currentTimeMs());
  const elapsedMs = phase === "running" && activeState.startedAt
    ? Math.max(0, clockNow - activeState.startedAt)
    : activeState.elapsedMs;
  const timersRef = useRef([]);
  const audioContextRef = useRef(null);
  const scheduledAudioRef = useRef([]);

  function clearTimers() {
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    timersRef.current = [];
  }

  function clearRaceAudio() {
    scheduledAudioRef.current.forEach((source) => {
      try { source.stop(); } catch { /* 已停止的声源无需再次处理。 */ }
    });
    scheduledAudioRef.current = [];
  }

  useEffect(() => {
    if (phase !== "running" || !activeState.startedAt) return undefined;
    const timer = window.setInterval(() => setClockNow(currentTimeMs()), 30);
    return () => window.clearInterval(timer);
  }, [phase, activeState.startedAt]);

  useEffect(() => () => {
    clearTimers();
    clearRaceAudio();
    audioContextRef.current?.close?.();
  }, []);

  async function unlockAudio() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    if (!audioContextRef.current || audioContextRef.current.state === "closed") {
      audioContextRef.current = new AudioContextClass();
    }
    if (audioContextRef.current.state === "suspended") await audioContextRef.current.resume();
    return audioContextRef.current;
  }

  function scheduleRaceSignal(context, scheduledAt, randomDelayMs) {
    const firstToneOffset = AUDIO_WAKEUP_MS / 1000;
    const startToneOffset = firstToneOffset + 2 + randomDelayMs / 1000;
    const signalDuration = startToneOffset + 0.95;
    const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * signalDuration), context.sampleRate);
    const samples = buffer.getChannelData(0);

    function writeTriangleTone(startOffset, holdDuration, fadeDuration, frequency, volume) {
      const duration = holdDuration + fadeDuration;
      const startSample = Math.floor(startOffset * context.sampleRate);
      const endSample = Math.min(samples.length, Math.ceil((startOffset + duration) * context.sampleRate));
      for (let sampleIndex = startSample; sampleIndex < endSample; sampleIndex += 1) {
        const localTime = sampleIndex / context.sampleRate - startOffset;
        const fadeProgress = Math.max(0, (localTime - holdDuration) / fadeDuration);
        const envelope = fadeProgress > 0 ? volume * Math.pow(0.00001 / volume, Math.min(1, fadeProgress)) : volume;
        const wave = (2 / Math.PI) * Math.asin(Math.sin(2 * Math.PI * frequency * localTime));
        samples[sampleIndex] += wave * envelope;
      }
    }

    for (let index = 0; index < 3; index += 1) {
      writeTriangleTone(firstToneOffset + index, 0.1, 1, 440, 1);
    }
    writeTriangleTone(startToneOffset, 0.7, 0.25, 880, 1);

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start(scheduledAt);
    scheduledAudioRef.current.push(source);
    source.onended = () => {
      scheduledAudioRef.current = scheduledAudioRef.current.filter((item) => item !== source);
    };
    return scheduledAt + startToneOffset;
  }

  async function startRace() {
    if (!canEdit || !match || phase === "countdown" || phase === "running") return;
    clearTimers();
    clearRaceAudio();
    const audioContext = await unlockAudio();
    const randomSeed = new Uint32Array(1);
    window.crypto.getRandomValues(randomSeed);
    const randomDelay = 1000 + (randomSeed[0] / 0xffffffff) * 4000;
    let scheduledStartAt = currentTimeMs()
      + AUDIO_SCHEDULING_LEAD_MS
      + AUDIO_WAKEUP_MS
      + 2000
      + randomDelay
      + RACE_START_COMPENSATION_MS;

    if (audioContext) {
      const wakeupAt = audioContext.currentTime + AUDIO_SCHEDULING_LEAD_MS / 1000;
      const audioStartAt = scheduleRaceSignal(audioContext, wakeupAt, randomDelay);
      scheduledStartAt = audioContextTimeToEpochMs(audioContext, audioStartAt) + RACE_START_COMPENSATION_MS;
    }

    onRaceStateChange({
      matchId: match.id,
      phase: "countdown",
      scheduledStartAt,
      startedAt: scheduledStartAt,
      elapsedMs: 0,
    });
    timersRef.current.push(window.setTimeout(() => {
      const now = currentTimeMs();
      setClockNow(now);
      onRaceStateChange({
        matchId: match.id,
        phase: "running",
        scheduledStartAt,
        startedAt: scheduledStartAt,
        elapsedMs: Math.max(0, now - scheduledStartAt),
      });
    }, Math.max(0, scheduledStartAt - currentTimeMs())));
  }

  function stopRace() {
    if (!canEdit) return;
    if (phase === "countdown") {
      clearTimers();
      clearRaceAudio();
    }
    const stoppedElapsed = elapsedMs;
    onRaceStateChange({ ...activeState, phase: "stopped", scheduledStartAt: 0, elapsedMs: stoppedElapsed });
  }

  function resumeRace() {
    if (!canEdit || !match || phase !== "stopped") return;
    const now = currentTimeMs();
    setClockNow(now);
    onRaceStateChange({
      ...activeState,
      matchId: match.id,
      phase: "running",
      scheduledStartAt: 0,
      startedAt: now - elapsedMs,
      elapsedMs,
    });
  }

  function finishRace() {
    if (!canEdit) return;
    clearTimers();
    clearRaceAudio();
    onFinishMatch?.(match.id, elapsedMs);
  }

  function toggleRace() {
    if (phase === "countdown" || phase === "running") stopRace();
    else if (phase === "stopped") resumeRace();
    else startRace();
  }

  if (!match) {
    return (
      <section style={styles.racePanel}>
        <h2 style={{ margin: 0 }}>比赛计时</h2>
        <div style={{ marginTop: 8, color: "#64748b" }}>当前没有可进行的比赛。</div>
      </section>
    );
  }

  return (
    <section style={styles.racePanel}>
      <div className="race-control-header">
        <div className="race-control-match-title">
          <div style={{ color: "#000000", fontWeight: 700, textAlign: "left" }}>{match.title}</div>
        </div>
        <div className="race-control-timer">
          <div style={styles.timer}>{phase === "countdown" ? "•••" : formatRaceTime(elapsedMs)}</div>
        </div>
        {canEdit && <div className="race-control-actions">
          <button type="button" onClick={toggleRace} style={{ ...styles.button, ...(phase === "countdown" || phase === "running" ? { background: "#dc2626", color: "#fff", borderColor: "#dc2626" } : styles.primaryButton) }}>{phase === "countdown" || phase === "running" ? "暂停" : phase === "stopped" ? "继续" : "发令"}</button>
          <button type="button" onClick={finishRace} disabled={phase === "ready"} title="结束本局、归零并切换到下一局" style={{ ...styles.button, opacity: phase === "ready" ? 0.5 : 1 }}>结束</button>
        </div>}
      </div>
      <div style={styles.lapGrid}>
        {match.slots.map((player, slotIndex) => {
          if (!isRealPlayer(player)) return null;
          const result = match.results[slotIndex] || blankResult();
          const laps = Number(result.laps) || 0;
          const disabled = phase !== "running" || result.dnf || laps >= 3;
          return (
            <button
              key={`${match.id}-${player.id}`}
              type="button"
              disabled={!canEdit || disabled}
              onClick={() => onRecordLap(match.id, slotIndex, Math.min(3, laps + 1), elapsedMs)}
              style={{ ...styles.lapButton, opacity: !canEdit || disabled ? 0.62 : 1, cursor: !canEdit ? "default" : "pointer" }}
            >
              <span style={{ display: "block", fontSize: 15 }}>{playerDisplayName(player)}</span>
              <span style={{ display: "block", marginTop: 4, color: "#64748b", fontSize: 12 }}>{result.dnf ? "DNF" : `${laps}/3 圈${result.seconds !== "" ? ` · ${result.seconds}s` : ""}`}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function UnifiedBracket({ bracket, onResultChange, onManualWinner, onSelectCurrent, canEdit }) {
  const sectionRef = React.useRef(null);
  const outerRef = React.useRef(null);
  const wrapperRef = React.useRef(null);
  const canvasRef = React.useRef(null);
  const zoomLabelRef = React.useRef(null);
  const dragRef = React.useRef({ active: false, x: 0, y: 0, left: 0, top: 0 });
  const pinchRef = React.useRef({ points: new Map(), active: false, moved: false, distance: 0, zoom: 1, currentZoom: 1, logicalX: 0, logicalY: 0, clientX: 0, clientY: 0, frame: 0 });
  const wheelRef = React.useRef({ frame: 0, delta: 0, clientX: 0, clientY: 0 });
  const [fullscreen, setFullscreen] = useState(false);
  const [viewport, setViewport] = useState({ width: 1400, height: 720 });
  const [fitRevision, setFitRevision] = useState(0);
  const [zoom, setZoom] = useState("fit");
  const layout = useMemo(() => buildUnifiedLayout(bracket), [bracket]);
  const matches = useMemo(() => allMatches(bracket), [bracket]);
  const availableW = Math.max(240, viewport.width - CANVAS_PAN_PADDING * 2);
  const availableH = Math.max(240, viewport.height - CANVAS_PAN_PADDING * 2);
  const fitZoom = Math.min(1, availableW / layout.width, availableH / layout.height);
  const actualZoom = zoom === "fit" ? fitZoom : zoom;
  const scaledWidth = layout.width * actualZoom;
  const scaledHeight = layout.height * actualZoom;
  const zoomValueRef = useRef(actualZoom);
  zoomValueRef.current = actualZoom;
  const baseWrapperWidth = zoom === "fit" ? Math.max(availableW, scaledWidth) : scaledWidth;
  const baseWrapperHeight = zoom === "fit" ? Math.max(availableH, scaledHeight) : scaledHeight;
  const wrapperWidth = baseWrapperWidth + CANVAS_PAN_PADDING * 2;
  const wrapperHeight = baseWrapperHeight + CANVAS_PAN_PADDING * 2;
  const offsetX = CANVAS_PAN_PADDING + (zoom === "fit" ? Math.max(0, (baseWrapperWidth - scaledWidth) / 2) : 0);
  const offsetY = CANVAS_PAN_PADDING + (zoom === "fit" ? Math.max(0, (baseWrapperHeight - scaledHeight) / 2) : 0);
  const lines = useMemo(() => matches.flatMap((match) => {
    const winnerTargets = match.winnerTargets?.length ? match.winnerTargets : (match.winnerTarget ? [match.winnerTarget] : []);
    return winnerTargets.map((target, index) => {
      const from = layout.positions.get(match.id);
      const to = layout.positions.get(target.matchId);
      return from && to ? { id: `${match.id}->${target.matchId}-${index}`, path: connectorPath(from, to, target.slot) } : null;
    }).filter(Boolean);
  }), [layout, matches]);

  useEffect(() => {
    const outer = outerRef.current;
    if (!outer) return undefined;
    function updateViewport() {
      setViewport({ width: outer.clientWidth, height: outer.clientHeight });
    }
    updateViewport();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(updateViewport) : null;
    observer?.observe(outer);
    window.addEventListener("resize", updateViewport);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateViewport);
    };
  }, [fullscreen]);

  useEffect(() => {
    const outer = outerRef.current;
    if (!outer) return undefined;
    const wheelState = wheelRef.current;
    function zoomWithWheel(event) {
      event.preventDefault();
      const rawDelta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? outer.clientHeight : 1;
      wheelState.delta += rawDelta * unit;
      wheelState.clientX = event.clientX;
      wheelState.clientY = event.clientY;
      if (wheelState.frame) return;

      wheelState.frame = window.requestAnimationFrame(() => {
        wheelState.frame = 0;
        const delta = Math.max(-120, Math.min(120, wheelState.delta));
        wheelState.delta = 0;
        const currentZoom = zoomValueRef.current;
        const nextZoom = Math.min(1.8, Math.max(0.35, currentZoom * Math.exp(-delta * 0.0012)));
        if (Math.abs(nextZoom - currentZoom) < 0.0001) return;

        const rect = outer.getBoundingClientRect();
        const cursorX = wheelState.clientX - rect.left;
        const cursorY = wheelState.clientY - rect.top;
        const logicalX = (outer.scrollLeft + cursorX - offsetX) / currentZoom;
        const logicalY = (outer.scrollTop + cursorY - offsetY) / currentZoom;
        zoomValueRef.current = nextZoom;
        setZoom(nextZoom);

        window.requestAnimationFrame(() => {
          outer.scrollLeft = CANVAS_PAN_PADDING + logicalX * nextZoom - cursorX;
          outer.scrollTop = CANVAS_PAN_PADDING + logicalY * nextZoom - cursorY;
        });
      });
    }
    outer.addEventListener("wheel", zoomWithWheel, { passive: false });
    return () => {
      outer.removeEventListener("wheel", zoomWithWheel);
      if (wheelState.frame) window.cancelAnimationFrame(wheelState.frame);
      wheelState.frame = 0;
      wheelState.delta = 0;
    };
  }, [offsetX, offsetY]);

  useEffect(() => {
    const outer = outerRef.current;
    if (!outer) return;
    const frame = window.requestAnimationFrame(() => {
      outer.scrollLeft = Math.max(0, (outer.scrollWidth - outer.clientWidth) / 2);
      outer.scrollTop = Math.max(0, (outer.scrollHeight - outer.clientHeight) / 2);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [layout.width, layout.height, viewport.width, viewport.height, fitRevision, fullscreen]);

  useEffect(() => {
    function handleFullscreenChange() {
      setFullscreen(document.fullscreenElement === sectionRef.current);
    }
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  async function toggleFullscreen() {
    if (!sectionRef.current) return;
    if (document.fullscreenElement === sectionRef.current) {
      await document.exitFullscreen?.();
      return;
    }
    await sectionRef.current.requestFullscreen?.();
    fitToWindow();
  }

  function fitToWindow() {
    setZoom("fit");
    setFitRevision((revision) => revision + 1);
  }

  function applyPinchFrame() {
    const pinch = pinchRef.current;
    pinch.frame = 0;
    const outer = outerRef.current;
    const wrapper = wrapperRef.current;
    const canvas = canvasRef.current;
    if (!outer || !wrapper || !canvas) return;
    const nextZoom = pinch.currentZoom;
    zoomValueRef.current = nextZoom;
    wrapper.style.width = `${layout.width * nextZoom + CANVAS_PAN_PADDING * 2}px`;
    wrapper.style.height = `${layout.height * nextZoom + CANVAS_PAN_PADDING * 2}px`;
    canvas.style.transform = `translate3d(${CANVAS_PAN_PADDING}px, ${CANVAS_PAN_PADDING}px, 0) scale(${nextZoom})`;
    if (zoomLabelRef.current) zoomLabelRef.current.textContent = `${Math.round(nextZoom * 100)}%`;

    const canvasRect = canvas.getBoundingClientRect();
    outer.scrollLeft += canvasRect.left + pinch.logicalX * nextZoom - pinch.clientX;
    outer.scrollTop += canvasRect.top + pinch.logicalY * nextZoom - pinch.clientY;
  }

  function handlePointerDown(event) {
    if (!outerRef.current) return;
    if (canEdit && event.target.closest?.('[data-no-pan="true"]')) return;
    if (event.pointerType === "touch") {
      const points = pinchRef.current.points;
      points.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (points.size === 2) {
        const [first, second] = [...points.values()];
        const centerX = (first.x + second.x) / 2;
        const centerY = (first.y + second.y) / 2;
        const currentZoom = zoomValueRef.current;
        const canvasRect = canvasRef.current?.getBoundingClientRect();
        pinchRef.current = {
          points,
          active: true,
          moved: false,
          distance: Math.hypot(second.x - first.x, second.y - first.y),
          zoom: currentZoom,
          currentZoom,
          logicalX: canvasRect ? (centerX - canvasRect.left) / currentZoom : 0,
          logicalY: canvasRect ? (centerY - canvasRect.top) / currentZoom : 0,
          clientX: centerX,
          clientY: centerY,
          frame: 0,
        };
        dragRef.current.active = false;
      } else {
        dragRef.current = {
          active: true,
          x: event.clientX,
          y: event.clientY,
          left: outerRef.current.scrollLeft,
          top: outerRef.current.scrollTop,
        };
      }
      outerRef.current.setPointerCapture?.(event.pointerId);
      return;
    }
    event.preventDefault();
    dragRef.current = {
      active: true,
      x: event.clientX,
      y: event.clientY,
      left: outerRef.current.scrollLeft,
      top: outerRef.current.scrollTop,
    };
    outerRef.current.setPointerCapture?.(event.pointerId);
  }

  function handlePointerMove(event) {
    if (event.pointerType === "touch" && pinchRef.current.points.has(event.pointerId)) {
      const points = pinchRef.current.points;
      points.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pinchRef.current.active && points.size === 2) {
        const [first, second] = [...points.values()];
        const distance = Math.hypot(second.x - first.x, second.y - first.y);
        if (pinchRef.current.distance > 0) {
          const nextZoom = Math.min(1.8, Math.max(0.35, pinchRef.current.zoom * distance / pinchRef.current.distance));
          pinchRef.current.moved = pinchRef.current.moved || Math.abs(nextZoom - pinchRef.current.zoom) > 0.0001;
          pinchRef.current.currentZoom = nextZoom;
          pinchRef.current.clientX = (first.x + second.x) / 2;
          pinchRef.current.clientY = (first.y + second.y) / 2;
          if (!pinchRef.current.frame) pinchRef.current.frame = window.requestAnimationFrame(applyPinchFrame);
        }
      } else if (dragRef.current.active && outerRef.current) {
        const dx = event.clientX - dragRef.current.x;
        const dy = event.clientY - dragRef.current.y;
        outerRef.current.scrollLeft = dragRef.current.left - dx;
        outerRef.current.scrollTop = dragRef.current.top - dy;
      }
      return;
    }
    if (!dragRef.current.active || !outerRef.current) return;
    event.preventDefault();
    const dx = event.clientX - dragRef.current.x;
    const dy = event.clientY - dragRef.current.y;
    outerRef.current.scrollLeft = dragRef.current.left - dx;
    outerRef.current.scrollTop = dragRef.current.top - dy;
  }

  function handlePointerUp(event) {
    if (event?.pointerType === "touch") {
      pinchRef.current.points.delete(event.pointerId);
      if (pinchRef.current.points.size < 2) {
        if (pinchRef.current.frame) {
          window.cancelAnimationFrame(pinchRef.current.frame);
          applyPinchFrame();
        }
        pinchRef.current.active = false;
        if (pinchRef.current.moved) setZoom(pinchRef.current.currentZoom);
        const remaining = [...pinchRef.current.points.values()][0];
        if (remaining && outerRef.current) {
          window.requestAnimationFrame(() => {
            if (!outerRef.current || pinchRef.current.active) return;
            dragRef.current = {
              active: true,
              x: remaining.x,
              y: remaining.y,
              left: outerRef.current.scrollLeft,
              top: outerRef.current.scrollTop,
            };
          });
          return;
        }
      }
    }
    dragRef.current.active = false;
  }

  return (
    <section ref={sectionRef} style={{ ...styles.panel, ...(fullscreen ? styles.bracketPanelFullscreen : {}) }}>
      <div style={styles.zoomBar}>
        <div>
          <h2 style={{ margin: 0, fontSize: 24, fontWeight: 900 }}>对阵树状全览</h2>
          <div style={styles.legendRows}>
            <div style={styles.legendRow}>
              <span style={styles.legendStrong}>颜色：</span>
              <span style={{ color: "#ea580c" }}>浅橙＝当前比赛</span>
              <span style={{ color: "#2563eb" }}>浅蓝＝下一局</span>
              <span style={{ color: "#a16207" }}>黄色＝平局待裁定</span>
            </div>
            <div style={styles.legendRow}>
              <span style={styles.legendStrong}>结果：</span>
              <span>绿色加粗＝胜者 / 晋级</span>
              {bracket.format !== "duel" && <span style={{ color: "#b45309" }}>橙色文字＝掉入败者组</span>}
              <span>灰色划线＝淘汰</span>
              {bracket.format === "duel" && <span>BYE＝轮空自动晋级</span>}
            </div>
            <div style={styles.legendRow}>
              <span style={styles.legendStrong}>计分：</span>
              <span>圈数多者胜</span>
              <span>同圈数秒数少者胜</span>
              <span>DNF 必输</span>
            </div>
          </div>
        </div>
        <div style={styles.zoomControls}>
          <button type="button" style={{ ...styles.button, ...styles.primaryButton, height: 46, padding: "0 20px", fontSize: 15 }} onClick={fitToWindow}>适应窗口</button>
          <button type="button" style={styles.button} onClick={() => setZoom((z) => Math.max(0.35, (z === "fit" ? fitZoom : z) - 0.1))}>−</button>
          <span ref={zoomLabelRef} style={{ fontWeight: 900, minWidth: 58, textAlign: "center" }}>{Math.round(actualZoom * 100)}%</span>
          <button type="button" style={styles.button} onClick={() => setZoom((z) => Math.min(1.8, (z === "fit" ? fitZoom : z) + 0.1))}>＋</button>
          <button type="button" style={styles.button} onClick={() => setZoom(1)}>100%</button>
          <button type="button" style={styles.button} onClick={toggleFullscreen}>{fullscreen ? "退出全屏" : "全屏显示"}</button>
        </div>
      </div>
      <div
        ref={outerRef}
        className="bracket-scroll-viewport"
        style={{ ...styles.bracketOuter, ...(fullscreen ? styles.bracketOuterFullscreen : {}), cursor: "grab", touchAction: "none" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDragStart={(event) => event.preventDefault()}
      >
        <div ref={wrapperRef} style={{ width: wrapperWidth, height: wrapperHeight, position: "relative", margin: "0 auto" }}>
          <div ref={canvasRef} style={{ ...styles.bracketCanvas, width: layout.width, height: layout.height, transform: `translate3d(${offsetX}px, ${offsetY}px, 0) scale(${actualZoom})` }}>
            <svg width={layout.width} height={layout.height} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
              {lines.map((line) => <path key={line.id} d={line.path} fill="none" stroke="#94a3b8" strokeWidth="2.5" />)}
            </svg>
            {layout.titles.map((title) => <div key={title.text} style={{ ...styles.sectionTitle, left: title.x, top: title.y }}>{title.text}</div>)}
            {matches.map((match) => {
              const pos = layout.positions.get(match.id);
              return pos ? <MatchCard key={match.id} match={match} x={pos.x} y={pos.y} onResultChange={onResultChange} onManualWinner={onManualWinner} onSelectCurrent={onSelectCurrent} canEdit={canEdit} /> : null;
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

function runSelfTests() {
  Object.keys(FORMAT_OPTIONS).forEach((formatId) => {
    for (let playerCount = 4; playerCount <= 16; playerCount += 1) {
      const candidate = recomputeBracket(createTournament(playerCount, formatId));
      console.assert(
        allMatches(candidate).every((match) => match.results.length >= match.slots.length),
        `${formatId} ${playerCount} 人签表的成绩槽位必须覆盖全部选手槽位`,
      );
      const candidateLayout = buildUnifiedLayout(candidate);
      console.assert(candidateLayout.width > 0 && candidateLayout.height > 0, `${formatId} ${playerCount} 人签表必须可布局`);
    }
  });

  const b5 = recomputeBracket(createEmptyBracket(5));
  console.assert(b5.size === 8, "5 人比赛应补到 8 人签表");
  console.assert(b5.winners[0][0].slots[1]?.bye, "5 人时 1 号种子应轮空");
  console.assert(b5.winners[0][2].slots[1]?.bye, "5 人时 2 号种子应轮空");
  console.assert(b5.winners[0][3].slots[1]?.bye, "5 人时 3 号种子应轮空");

  const b5Started = createEmptyBracket(5);
  b5Started.winners[0][1].results[0] = { laps: "1", seconds: "12", dnf: false };
  b5Started.winners[0][1].results[1] = { laps: "2", seconds: "30", dnf: false };
  const c5 = recomputeBracket(b5Started);
  console.assert(c5.losers[0][1].slots.every((p) => p?.bye), "5 人时，两个首轮 BYE 来源组成的败者组比赛应是 BYE vs BYE");
  console.assert(c5.losers[1][1].slots[0]?.bye, "BYE vs BYE 应继续向下一轮传播结构性 BYE，不能让后续场次卡住");

  const b7 = recomputeBracket(createEmptyBracket(7));
  console.assert(b7.size === 8, "7 人比赛应补到 8 人签表");
  console.assert(b7.winners[0][0].slots[1]?.bye, "7 人时 BYE 应给到 1 号种子首轮轮空");
  console.assert(b7.winners[1][0].slots[0]?.id === "P1", "1 号种子遇 BYE 后应自动进入胜者组第二轮");

  const b16 = createEmptyBracket(16);
  console.assert(b16.winners.length === 4, "16 人胜者组应有 4 轮");
  console.assert(b16.losers.map((round) => round.length).join(",") === "4,4,2,2,1,1", "16 人败者组轮次应为 4,4,2,2,1,1");

  const byResult = { slots: [{ id: "P1", name: "A" }, { id: "P2", name: "B" }], results: [{ laps: "3", seconds: "61.2", dnf: false }, { laps: "3", seconds: "62.8", dnf: false }], manualWinnerSlot: null, isTie: false };
  console.assert(resolveResult(byResult).winner?.id === "P1", "圈数相同，秒数少者应获胜");

  const byLaps = { slots: [{ id: "P1", name: "A" }, { id: "P2", name: "B" }], results: [{ laps: "2", seconds: "40", dnf: false }, { laps: "3", seconds: "99", dnf: false }], manualWinnerSlot: null, isTie: false };
  console.assert(resolveResult(byLaps).winner?.id === "P2", "圈数多者应获胜");

  const byDnf = { slots: [{ id: "P1", name: "A" }, { id: "P2", name: "B" }], results: [{ laps: "", seconds: "", dnf: true }, { laps: "0", seconds: "0", dnf: false }], manualWinnerSlot: null, isTie: false };
  console.assert(resolveResult(byDnf).winner?.id === "P2", "DNF 一定输");

  const emptyInput = { slots: [{ id: "P1", name: "A" }, { id: "P2", name: "B" }], results: [blankResult(), blankResult()], manualWinnerSlot: null, isTie: false };
  console.assert(resolveResult(emptyInput).winner === null && !emptyInput.isTie, "双方都没输入时不应显示平局待裁定");

  const tieDnf = { slots: [{ id: "P1", name: "A" }, { id: "P2", name: "B" }], results: [{ laps: "", seconds: "", dnf: true }, { laps: "", seconds: "", dnf: true }], manualWinnerSlot: null, isTie: false };
  console.assert(resolveResult(tieDnf).winner === null && tieDnf.isTie, "双 DNF 应进入待裁定平局状态");
  tieDnf.manualWinnerSlot = 1;
  console.assert(resolveResult(tieDnf).winner?.id === "P2", "平局手动判胜后应继续推进");

  const tieTime = { slots: [{ id: "P1", name: "A" }, { id: "P2", name: "B" }], results: [{ laps: "2", seconds: "33.3", dnf: false }, { laps: "2", seconds: "33.3", dnf: false }], manualWinnerSlot: null, isTie: false };
  console.assert(resolveResult(tieTime).winner === null && tieTime.isTie, "同圈同秒应进入待裁定平局状态");

  const layout = buildUnifiedLayout(createEmptyBracket(8));
  console.assert(layout.width > 0 && layout.height > 0, "布局宽高应为正数");

  const highlightBracket = recomputeBracket(createEmptyBracket(8));
  const originalQueue = getPlayableQueue(highlightBracket);
  console.assert(allMatches(highlightBracket).filter((match) => match.highlight === "current").length === 1, "当前可进行比赛应只高亮一场");
  console.assert(allMatches(highlightBracket).filter((match) => match.highlight === "next1").length === 1, "下一场比赛应只高亮一场");
  console.assert(getSingleCurrentMatch(highlightBracket)?.id === "W-0-0", "初始当前比赛应为第一列最上方比赛");
  console.assert(originalQueue[0]?.highlight === "current" && originalQueue[1]?.highlight === "next1", "自动当前局和蓝色下一局必须沿用原版 1V1 可比赛队列顺序");

  const singleReadyRaw = createEmptyBracket(4);
  const firstReady = findMatch(singleReadyRaw, "W-0-0");
  setProjectedMatchResult(firstReady);
  const singleReadyBracket = recomputeBracket(singleReadyRaw);
  const singleReadyQueue = getPlayableQueue(singleReadyBracket);
  console.assert(singleReadyQueue.length === 1 && singleReadyQueue[0].highlight === "current", "完成首局后只剩一场可比赛时仍应正确标出当前局");
  console.assert(allMatches(singleReadyBracket).some((match) => match.highlight === "next1"), "只有当前局已就绪时也必须预判并显示蓝色自动下一局");

  const fourDuelCount = getTournamentMatchCount(4, "duel");
  console.assert(fourDuelCount.normal === 6 && fourDuelCount.withReset === 7, "4 人 1V1 双败应进行 6 局，触发总决赛重赛时共 7 局");
  Object.keys(FORMAT_OPTIONS).forEach((formatId) => {
    const planned = getTournamentMatchCount(7, formatId);
    console.assert(planned.normal > 0 && planned.withReset >= planned.normal, `${formatId} 的比赛局数估算必须有效`);
  });

  const rankings = getRankings(recomputeBracket(createEmptyBracket(8)));
  console.assert(rankings.length === 8, "排名列表应包含所有真实选手");
  console.assert(rankings.every((item) => item.rank === "未定"), "没有二败淘汰前，所有排名都应为未定");

  const triple = recomputeBracket(createTournament(7, "triple"));
  console.assert(triple.winners[0].map((match) => match.slots.length).join(",") === "3,3,3", "7 人三人赛首轮余数分组应补齐为 BYE");
  console.assert(triple.winners[0][2].advancing[0]?.id, "单人余数组应自动轮空晋级");
  console.assert(triple.doubleEliminationMulti && triple.losers.length > 0, "三人赛必须包含败者组");
  console.assert(triple.finals[0].slots.length === 2, "三人双败赛应由胜者组冠军和败者组冠军进入总决赛");
  console.assert(triple.winners.flat().some((match) => match.loserTargets?.length), "三人赛胜者组落败者必须有败者组去向");

  const tripleStarted = createTournament(7, "triple");
  tripleStarted.winners[0].slice(0, 2).forEach((match) => {
    match.results = match.results.map((_, index) => ({ laps: "3", seconds: String(20 + index), dnf: false }));
  });
  const tripleAdvanced = recomputeBracket(tripleStarted);
  console.assert(tripleAdvanced.winners[1][0].slots.every(isRealPlayer), "三人赛首轮完成后应把晋级者填入下一轮");
  console.assert(tripleAdvanced.winners[1][1].advancing.length === 2, "三人赛两人余数组应自动全部晋级");

  const quad = recomputeBracket(createTournament(9, "quad"));
  console.assert(quad.winners[0].map((match) => match.slots.length).join(",") === "4,4,4", "9 人四人赛首轮余数分组应补齐为 BYE");
  console.assert(quad.doubleEliminationMulti && quad.losers.length > 0, "四人赛必须包含败者组");
  console.assert(quad.finals[0].slots.length === 2, "四人双败赛应由胜者组冠军和败者组冠军进入总决赛");

  const sixPlayerQuad = recomputeBracket(createTournament(6, "quad"));
  console.assert(allMatches(sixPlayerQuad).filter((match) => match.highlight === "next1").length === 1, "六人四进二初始签表必须显示蓝色下一局");

  const quadMatch = createMultiRound("TEST", 0, [4], 2, "测试", "drop")[0];
  quadMatch.slots = createPlayers(4);
  quadMatch.results = quadMatch.results.map((_, index) => ({ laps: "3", seconds: String(30 + index), dnf: false }));
  const quadOutcome = resolveMultiResult(quadMatch);
  console.assert(quadOutcome.advancing.map((player) => player.id).join(",") === "P1,P2" && quadOutcome.eliminated.length === 2, "四进二应按圈数和用时决出两名晋级者");

  const lapProgressMatch = createMultiRound("TEST", 0, [3], 2, "测试", "drop")[0];
  lapProgressMatch.slots = createPlayers(3);
  lapProgressMatch.results = lapProgressMatch.results.map(() => ({ laps: "1", seconds: "10.00", dnf: false, timerInProgress: true }));
  const lapProgressOutcome = resolveMultiResult(lapProgressMatch);
  console.assert(lapProgressOutcome.advancing.length === 0, "多人各完成一圈时只能记录过圈进度，不能提前结束比赛");

  const pendingFeedMatch = createMultiRound("TEST", 0, [3], 1, "测试", "eliminate", 3)[0];
  pendingFeedMatch.slots[0] = createPlayers(1)[0];
  pendingFeedMatch.results[0] = { laps: "3", seconds: "10.00", dnf: false };
  console.assert(resolveMultiResult(pendingFeedMatch).advancing.length === 0, "多人局仍有待定来源槽位时，已到位选手不能提前显示为晋级");
  pendingFeedMatch.slots[1] = { id: "TEST-BYE-1", name: "BYE", bye: true, structuralBye: true };
  pendingFeedMatch.slots[2] = { id: "TEST-BYE-2", name: "BYE", bye: true, structuralBye: true };
  console.assert(resolveMultiResult(pendingFeedMatch).advancing[0]?.id === "P1", "明确的结构性 BYE 到位后，余下真人可以正常自动晋级");

  const selectedHighlightBracket = recomputeBracket(createTournament(7, "triple"));
  const selectedMatch = selectedHighlightBracket.winners[0][1];
  annotateMatchHighlights(selectedHighlightBracket, selectedMatch.id);
  const expectedAutomaticNext = getPlayableQueue(selectedHighlightBracket).find((match) => match.id !== selectedMatch.id);
  console.assert(selectedMatch.highlight === "current", "手动选择的对局应成为当前对局");
  console.assert(expectedAutomaticNext?.highlight === "next1", "手动调整结束后的蓝色下一局必须与自动队列一致");

  const allDnfFinish = finishBracketMatch(createTournament(4, "duel"), "W-0-0", 12000);
  console.assert(allDnfFinish.finishedMatch?.isTie && !allDnfFinish.finishedMatch?.winner, "同为 DNF 时必须保留平局并等待裁判，不能自动选人");
  console.assert(findMatch(allDnfFinish.rawBracket, "W-0-0")?.manualWinnerSlot == null, "结束按钮不能擅自写入平局裁判结果");

  let finishFlow = createTournament(4, "duel");
  findMatch(finishFlow, "W-0-0").results[0] = { laps: "1", seconds: "10.00", dnf: false, timerInProgress: true };
  let finished = finishBracketMatch(finishFlow, "W-0-0", 12000);
  console.assert(finished.finishedMatch?.winner?.id === "P1", "提前结束时应保留当前圈数，并把未记录成绩的选手记为 DNF");
  console.assert(finished.nextMatch?.id === "W-0-1", "下一局应按实际比赛队列标记，而不是标记当前局的晋级去向");
  finishFlow = finished.rawBracket;
  findMatch(finishFlow, "W-0-1").results[0] = { laps: "1", seconds: "11.00", dnf: false, timerInProgress: true };
  finished = finishBracketMatch(finishFlow, "W-0-1", 13000);
  finishFlow = finished.rawBracket;
  const generatedSlotMatch = getPlayableQueue(finished.computedBracket)[0];
  console.assert(generatedSlotMatch && findMatch(finishFlow, generatedSlotMatch.id)?.slots.every((player) => !player), "测试局应覆盖原始数据中尚未写入选手的后续轮次");
  findMatch(finishFlow, generatedSlotMatch.id).results[0] = { laps: "1", seconds: "12.00", dnf: false, timerInProgress: true };
  finished = finishBracketMatch(finishFlow, generatedSlotMatch.id, 14000);
  console.assert(isMatchComplete(finished.finishedMatch), "后续轮次应使用计算后的选手槽位保存成绩并正常结束");
}

if (typeof window !== "undefined" && !window.__DOUBLE_ELIMINATION_TESTED_V12__) {
  window.__DOUBLE_ELIMINATION_TESTED_V12__ = true;
  runSelfTests();
}

if (typeof window === "undefined") {
  globalThis.__FPV_BRACKET_TEST_API__ = Object.freeze({
    allMatches,
    annotateMatchHighlights,
    bracketOrderMatches,
    cloneBracket,
    createMultiRound,
    createPlayers,
    createTournament,
    findMatch,
    finishBracketMatch,
    getPlayableQueue,
    isMatchComplete,
    isMultiMatch,
    isRealPlayer,
    matchRouteTargets,
    recomputeBracket,
    resolveMultiResult,
  });
}

export default function DoubleEliminationBracket() {
  const [page, setPage] = useState(() => (
    window.location.pathname.startsWith("/ground-station") ? "groundStation" : "portal"
  ));
  const [coachPassword, setCoachPassword] = useState("");
  const [coachError, setCoachError] = useState("");
  const [count, setCount] = useState(8);
  const [format, setFormat] = useState("duel");
  const [rawBracket, setRawBracket] = useState(() => createTournament(8, "duel"));
  const [pilotLibrary, setPilotLibrary] = useState([]);
  const [activeTraining, setActiveTraining] = useState(false);
  const [activeFrequencyByPilot, setActiveFrequencyByPilot] = useState({});
  const [saveStatus, setSaveStatus] = useState("未连接服务器");
  const [currentMatchId, setCurrentMatchId] = useState("");
  const [raceState, setRaceState] = useState(() => createRaceState());
  const saveTimerRef = useRef(null);
  const currentMatchIdRef = useRef("");
  const raceStateRef = useRef(createRaceState());
  const rawBracketRef = useRef(rawBracket);
  const canEditBracket = page === "coachBracket";
  const isBracketPage = page === "bracket" || page === "coachBracket";

  const bracket = useMemo(() => {
    const frequencySynced = activeTraining
      ? {
          ...rawBracket,
          players: rawBracket.players.map((player) => ({
            ...player,
            videoChannel: player.pilotId ? activeFrequencyByPilot[player.pilotId] || "" : "",
          })),
        }
      : rawBracket;
    const next = recomputeBracket(frequencySynced);
    annotateMatchHighlights(next, currentMatchId);
    return next;
  }, [rawBracket, activeTraining, activeFrequencyByPilot, currentMatchId]);
  const rankings = useMemo(() => getRankings(bracket), [bracket]);
  const currentMatch = useMemo(() => getSingleCurrentMatch(bracket, currentMatchId), [bracket, currentMatchId]);
  const matchCount = useMemo(() => getTournamentMatchCount(count, format), [count, format]);
  const selectedPilotIds = useMemo(() => new Set(bracket.players.map((player) => String(player.pilotId || "")).filter(Boolean)), [bracket.players]);
  const bracketLive = bracket.players.length === Number(count)
    && bracket.players.every((player) => Boolean(player.pilotId && String(player.name || "").trim()))
    && !bracket.champion;

  useEffect(() => {
    let stopped = false;
    async function loadPilots() {
      try {
        const [eventResponse, pilotResponse] = await Promise.all([
          fetch("/api/events", { cache: "no-store" }),
          isBracketPage ? fetch("/api/pilots", { cache: "no-store" }) : Promise.resolve(null),
        ]);
        const events = eventResponse.ok ? await eventResponse.json() : [];
        if (isBracketPage && !pilotResponse?.ok) throw new Error("读取飞手库失败");
        const pilots = pilotResponse?.ok ? await pilotResponse.json() : [];
        const event = (Array.isArray(events) ? events : []).find((item) => item.active);
        const frequencyByPilot = Object.fromEntries((event?.participants || []).map((participant) => [participant.pilotId, participant.videoChannel || ""]));
        if (!stopped) {
          setActiveTraining(Boolean(event));
          setActiveFrequencyByPilot(frequencyByPilot);
          if (isBracketPage) setPilotLibrary((Array.isArray(pilots) ? pilots : []).map((pilot) => ({ ...pilot, videoChannel: event ? frequencyByPilot[pilot.id] || "" : "" })));
        }
      } catch {
        if (!stopped) {
          if (isBracketPage) setPilotLibrary([]);
          setActiveTraining(false);
          setActiveFrequencyByPilot({});
        }
      }
    }
    loadPilots();
    const timer = window.setInterval(loadPilots, 2000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [isBracketPage]);

  function applySavedState(saved) {
    if (!saved || !saved.rawBracket) return;
    const storedBracket = { ...saved.rawBracket, format: saved.rawBracket.format || saved.format || "duel" };
    const nextBracket = repairBracketShape(storedBracket);
    const nextCount = Number(saved.count || nextBracket.playerCount || 8);
    const savedCurrentMatchId = findMatch(nextBracket, saved.manualCurrentMatchId) ? saved.manualCurrentMatchId : "";
    const savedRaceState = normalizeRaceState(saved.raceState);
    rawBracketRef.current = nextBracket;
    setRawBracket(nextBracket);
    setFormat(nextBracket.format);
    setCount(nextCount);
    currentMatchIdRef.current = savedCurrentMatchId;
    raceStateRef.current = savedRaceState;
    setCurrentMatchId(savedCurrentMatchId);
    setRaceState(savedRaceState);
  }

  function scheduleSave(nextRawBracket, nextCount = count) {
    if (!canEditBracket) return;
    setSaveStatus("正在保存...");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      try {
        await saveStateToServer({
          count: nextCount,
          format: nextRawBracket.format || format,
          rawBracket: nextRawBracket,
          manualCurrentMatchId: currentMatchIdRef.current,
          raceState: raceStateRef.current,
          updatedAt: new Date().toISOString(),
        });
        setSaveStatus("已保存到服务器 JSON");
      } catch {
        setSaveStatus("保存失败：请确认后端已启动");
      }
    }, 250);
  }

  function commitRawBracket(updater, nextCount = count) {
    setRawBracket((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      rawBracketRef.current = next;
      scheduleSave(next, nextCount);
      return next;
    });
  }

  useEffect(() => {
    let stopped = false;

    async function loadOnce() {
      try {
        const saved = await loadSavedState();
        if (!stopped) {
          applySavedState(saved);
          setSaveStatus(canEditBracket ? "已读取服务器 JSON" : "观众页自动刷新中");
        }
      } catch {
        if (!stopped) setSaveStatus("未读取到服务器 JSON，将使用本地初始数据");
      }
    }

    loadOnce();

    if (!canEditBracket) {
      const timer = setInterval(loadOnce, 1000);
      return () => {
        stopped = true;
        clearInterval(timer);
      };
    }

    return () => {
      stopped = true;
    };
  }, [canEditBracket]);

  function resetByCount(newCount) {
    if (!canEditBracket) return;
    const nextCount = Number(newCount);
    const nextBracket = createTournament(nextCount, format);
    currentMatchIdRef.current = "";
    raceStateRef.current = createRaceState();
    setCurrentMatchId("");
    setRaceState(raceStateRef.current);
    setCount(nextCount);
    commitRawBracket(nextBracket, nextCount);
  }

  function resetByFormat(nextFormat) {
    if (!canEditBracket || !FORMAT_OPTIONS[nextFormat]) return;
    const nextBracket = createTournament(count, nextFormat);
    currentMatchIdRef.current = "";
    raceStateRef.current = createRaceState();
    setCurrentMatchId("");
    setRaceState(raceStateRef.current);
    setFormat(nextFormat);
    rawBracketRef.current = nextBracket;
    setRawBracket(nextBracket);
    scheduleSave(nextBracket, count);
  }

  function updatePlayerFromPilot(id, pilotId) {
    if (!canEditBracket) return;
    const normalizedPilotId = String(pilotId || "");
    const pilot = pilotLibrary.find((item) => String(item.id) === normalizedPilotId);
    commitRawBracket((prev) => {
      if (normalizedPilotId && prev.players.some((player) => player.id !== id && String(player.pilotId || "") === normalizedPilotId)) return prev;
      return {
        ...prev,
        players: prev.players.map((player) => (
          player.id === id
            ? {
                ...player,
                pilotId: normalizedPilotId,
                name: pilot?.name || "",
                videoChannel: normalizedPilotId
                  ? (activeTraining ? activeFrequencyByPilot[normalizedPilotId] || "" : player.videoChannel || "")
                  : "",
              }
            : player
        )),
      };
    });
  }

  function updatePlayerFrequency(id, videoChannel) {
    if (!canEditBracket) return;
    commitRawBracket((prev) => ({
      ...prev,
      players: prev.players.map((player) => (player.id === id ? { ...player, videoChannel } : player)),
    }));
  }

  function updateResult(matchId, slotIndex, nextResult) {
    if (!canEditBracket) return;
    const normalized = { ...nextResult };
    if (normalized.dnf) { normalized.laps = ""; normalized.seconds = ""; }
    if (normalized.laps === "0") normalized.seconds = "0";

    commitRawBracket((prev) => {
      const next = cloneBracket(prev);
      const match = findMatch(next, matchId);
      if (!match) return prev;
      clearDownstreamResults(next, matchId);
      match.results[slotIndex] = { ...normalized };
      match.manualWinnerSlot = null;
      match.manualAdvancingSlots = [];
      return next;
    });
  }

  function updateManualWinner(matchId, slotIndex) {
    if (!canEditBracket) return;
    const next = cloneBracket(rawBracketRef.current);
    const match = findMatch(next, matchId);
    if (!match) return;
    if (isMultiMatch(match)) {
      const selected = new Set(match.manualAdvancingSlots || []);
      if (selected.has(slotIndex)) selected.delete(slotIndex);
      else if (selected.size < (Number(match.advanceCount) || 1)) selected.add(slotIndex);
      match.manualAdvancingSlots = [...selected];
    } else {
      match.manualWinnerSlot = slotIndex;
    }

    const computed = recomputeBracket(next, false);
    const judgedMatch = findMatch(computed, matchId);
    if (currentMatchIdRef.current === matchId && judgedMatch && isMatchComplete(judgedMatch)) {
      const nextMatchId = getPlayableQueue(computed)[0]?.id || "";
      const nextRaceState = createRaceState(nextMatchId);
      currentMatchIdRef.current = nextMatchId;
      raceStateRef.current = nextRaceState;
      setCurrentMatchId(nextMatchId);
      setRaceState(nextRaceState);
    }
    commitRawBracket(next);
  }

  function recordLap(matchId, slotIndex, laps, elapsedMs) {
    const seconds = Math.max(0, elapsedMs / 1000).toFixed(2);
    updateResult(matchId, slotIndex, { laps: String(laps), seconds, dnf: false, timerInProgress: laps < 3 });
  }

  function finishMatchAndAdvance(matchId, elapsedMs) {
    if (!canEditBracket) return;
    const finished = finishBracketMatch(rawBracketRef.current, matchId, elapsedMs);
    if (!finished.finishedMatch) return;
    const complete = isMatchComplete(finished.finishedMatch);
    const nextMatchId = complete ? finished.nextMatch?.id || "" : matchId;
    const nextRaceState = complete
      ? createRaceState(nextMatchId)
      : { ...createRaceState(matchId), phase: "stopped", elapsedMs: Math.max(0, Number(elapsedMs) || 0) };
    raceStateRef.current = nextRaceState;
    setRaceState(nextRaceState);
    currentMatchIdRef.current = nextMatchId;
    setCurrentMatchId(nextMatchId);
    commitRawBracket(finished.rawBracket);
  }

  function updateSyncedRaceState(nextValue) {
    if (!canEditBracket) return;
    const nextRaceState = normalizeRaceState(nextValue);
    raceStateRef.current = nextRaceState;
    setRaceState(nextRaceState);
    scheduleSave(rawBracketRef.current, count);
  }

  function selectCurrentMatch(match) {
    if (!canEditBracket || !match) return;
    if (match.slots.some((player) => !player)) {
      window.alert("本局还有待定选手，不能手动切换。");
      return;
    }
    if (match.id === currentMatchIdRef.current) return;
    const stateNote = isMatchComplete(match) ? "本局已有成绩，可在计时卡片中归零后重赛。" : "可在计时卡片中调整或开始本局。";
    if (!window.confirm(`手动调整“${match.title}”？\n${stateNote}\n完成后将继续自动切换下一局。`)) return;
    currentMatchIdRef.current = match.id;
    const nextRaceState = createRaceState(match.id);
    raceStateRef.current = nextRaceState;
    setCurrentMatchId(match.id);
    setRaceState(nextRaceState);
    scheduleSave(rawBracket, count);
  }

  async function handleManualSave() {
    if (!canEditBracket) return;
    try {
      setSaveStatus("正在手动保存...");
      await saveStateToServer({ count, format, rawBracket, manualCurrentMatchId: currentMatchIdRef.current, raceState: raceStateRef.current, updatedAt: new Date().toISOString() });
      setSaveStatus("已手动保存到服务器 JSON");
    } catch {
      setSaveStatus("手动保存失败：请确认后端已启动，并且访问的是 3000 端口");
    }
  }

  async function enterCoachMode(event) {
    event.preventDefault();
    const password = coachPassword.trim();
    if (!password) {
      setCoachError("请输入教练密码");
      return;
    }
    setCoachError("");
    try {
      await validateCoachPassword(password);
      saveCoachPassword(password);
      setCoachPassword("");
      setCoachError("");
      setPage("coachTraining");
    } catch (error) {
      setCoachError(error.message || "密码不正确");
    }
  }

  if (page === "groundStation") {
    return <GroundStationPage onBack={() => {
      window.history.pushState({}, "", "/");
      setPage("portal");
    }} />;
  }

  if (page === "portal") {
    return (
      <div style={styles.page}>
        <div style={{ ...styles.container, minHeight: "calc(100vh - 44px)", justifyContent: "center" }}>
          <section style={{ ...styles.panel, display: "grid", gap: 18 }}>
            <h1 style={styles.title}>FPV 赛事与训练系统</h1>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 14 }}>
              <button type="button"
                onClick={() => setPage("trackDisplay")}
                style={{ height: 72, borderRadius: 16, border: "none", padding: "0 24px", cursor: "pointer", fontWeight: 800, fontSize: 16, background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)", color: "#fff", boxShadow: "0 8px 32px rgba(102,126,234,.35)", transition: "transform .15s, box-shadow .15s" }}
                onMouseEnter={(e) => { e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = "0 14px 40px rgba(102,126,234,.45)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.transform = "translateY(0)"; e.currentTarget.style.boxShadow = "0 8px 32px rgba(102,126,234,.35)"; }}
              >🏁 训练赛道</button>
              <button type="button"
                onClick={() => setPage("publicMonitor")}
                className={activeTraining ? "portal-live-button" : undefined}
                style={{ position: "relative", height: 72, borderRadius: 16, border: "none", padding: "0 24px", cursor: "pointer", fontWeight: 800, fontSize: 16, background: "linear-gradient(135deg, #0ea5e9 0%, #06b6d4 50%, #10b981 100%)", color: "#fff", boxShadow: "0 8px 32px rgba(14,165,233,.35)", transition: "transform .15s, box-shadow .15s" }}
                onMouseEnter={(e) => { e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = "0 14px 40px rgba(14,165,233,.45)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.transform = "translateY(0)"; e.currentTarget.style.boxShadow = "0 8px 32px rgba(14,165,233,.35)"; }}
              >📡 训练状态监测{activeTraining && <LiveStatusBadge />}</button>
              <button type="button"
                onClick={() => setPage("publicSkillTree")}
                style={{ height: 72, borderRadius: 16, border: "none", padding: "0 24px", cursor: "pointer", fontWeight: 800, fontSize: 16, background: "linear-gradient(135deg, #2563eb 0%, #7c3aed 100%)", color: "#fff", boxShadow: "0 8px 32px rgba(37,99,235,.35)", transition: "transform .15s, box-shadow .15s" }}
                onMouseEnter={(e) => { e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = "0 14px 40px rgba(37,99,235,.45)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.transform = "translateY(0)"; e.currentTarget.style.boxShadow = "0 8px 32px rgba(37,99,235,.35)"; }}
              >🗺️ 技能树</button>
              <button type="button"
                onClick={() => setPage("bracket")}
                className={bracketLive ? "portal-live-button" : undefined}
                style={{ position: "relative", height: 72, borderRadius: 16, border: "none", padding: "0 24px", cursor: "pointer", fontWeight: 800, fontSize: 16, background: "linear-gradient(135deg, #f59e0b 0%, #ef4444 100%)", color: "#fff", boxShadow: "0 8px 32px rgba(245,158,11,.35)", transition: "transform .15s, box-shadow .15s" }}
                onMouseEnter={(e) => { e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = "0 14px 40px rgba(245,158,11,.45)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.transform = "translateY(0)"; e.currentTarget.style.boxShadow = "0 8px 32px rgba(245,158,11,.35)"; }}
              >🏆 双败淘汰赛{bracketLive && <LiveStatusBadge />}</button>
              <button type="button"
                onClick={() => {
                  window.history.pushState({}, "", "/ground-station");
                  setPage("groundStation");
                }}
                style={{ height: 72, borderRadius: 16, border: "none", padding: "0 24px", cursor: "pointer", fontWeight: 800, fontSize: 16, background: "linear-gradient(135deg, #123c2c 0%, #147a4b 55%, #46a46e 100%)", color: "#fff", boxShadow: "0 8px 32px rgba(20,122,75,.3)", transition: "transform .15s, box-shadow .15s" }}
                onMouseEnter={(e) => { e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = "0 14px 40px rgba(20,122,75,.4)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.transform = "translateY(0)"; e.currentTarget.style.boxShadow = "0 8px 32px rgba(20,122,75,.3)"; }}
              >🛠 车队地面站</button>
            </div>
            <button type="button" style={{ ...styles.button, height: 44, background: "#f8fafc", color: "#64748b" }} onClick={() => { clearCoachPassword(); setCoachPassword(""); setCoachError(""); setPage("coachLogin"); }}>
              教练模式
            </button>
          </section>
        </div>
      </div>
    );
  }

  if (page === "coachLogin") {
    return (
      <div style={styles.page}>
        <div style={{ ...styles.container, minHeight: "calc(100vh - 44px)", justifyContent: "center", maxWidth: 520 }}>
          <form style={{ ...styles.panel, display: "grid", gap: 12 }} onSubmit={enterCoachMode}>
            <h1 style={styles.title}>教练模式</h1>
            <input type="password" value={coachPassword} onChange={(event) => setCoachPassword(event.target.value)} placeholder="输入密码" style={styles.input} autoFocus />
            {coachError && <div style={{ color: "#b91c1c", fontSize: 13 }}>{coachError}</div>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" style={styles.button} onClick={() => setPage("portal")}>返回首页</button>
              <button type="submit" style={{ ...styles.button, ...styles.primaryButton }}>进入</button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  if (page === "publicMonitor") {
    return <TrainingPage audience initialTab="monitor" onBack={() => setPage("portal")} onOpenBracket={() => setPage("bracket")} bracketLive={bracketLive} />;
  }

  if (page === "publicSkillTree") {
    return (
      <div style={styles.page}>
        <div style={{ ...styles.container, maxWidth: 1100 }}>
          <header style={{ ...styles.panel, ...styles.header }}>
            <div>
              <h1 style={styles.title}>技能树</h1>
              <div style={styles.subtitle}>技能说明、description 和各星级标准。</div>
            </div>
            <button type="button" style={styles.button} onClick={() => setPage("portal")}>返回首页</button>
          </header>
          <AudienceSkillTreePanel />
        </div>
      </div>
    );
  }

  if (page === "trackDisplay") {
    return (
      <div style={styles.page}>
        <div style={{ ...styles.container, maxWidth: 1500 }}>
          <header style={{ ...styles.panel, ...styles.header }}>
            <div>
              <h1 style={styles.title}>训练赛道</h1>
              <div style={styles.subtitle}>当前训练赛道、器材统计和搬运方案。</div>
            </div>
            <button type="button" style={styles.button} onClick={() => setPage("portal")}>返回首页</button>
          </header>
          <TrackAudiencePanel showEmpty />
        </div>
      </div>
    );
  }

  const bracketPage = (
    <div className="tournament-page" style={styles.page}>
      <div style={styles.container}>
        <header className="tournament-header" style={styles.panel}>
          <div className="tournament-header-title">
            <h1 style={styles.title}>双败淘汰赛对阵表</h1>
            <div style={styles.subtitle}>
              状态：{saveStatus}
            </div>
          </div>
          <div className="tournament-match-count">
            预计 {matchCount.normal} 局
          </div>
          <div className="tournament-header-settings">
            <div className="tournament-format-controls" style={styles.controls}>
              <label htmlFor="race-format">赛制</label>
              <select id="race-format" value={format} onChange={(e) => resetByFormat(e.target.value)} style={styles.select} disabled={!canEditBracket}>
                {Object.values(FORMAT_OPTIONS).map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
              <label htmlFor="player-count">参赛人数</label>
              <select id="player-count" value={count} onChange={(e) => resetByCount(e.target.value)} style={styles.select} disabled={!canEditBracket}>
                {Array.from({ length: 13 }, (_, index) => index + 4).map((number) => <option key={number} value={number}>{number} 人</option>)}
              </select>
            </div>
          </div>
          <div className="tournament-header-actions" style={styles.controls}>
            {canEditBracket && <button type="button" style={styles.button} onClick={() => resetByCount(count)}>重置</button>}
            {canEditBracket && <button type="button" style={{ ...styles.button, ...styles.primaryButton }} onClick={handleManualSave}>立即保存</button>}
            {canEditBracket
              ? <button type="button" style={styles.button} onClick={() => setPage("coachTraining")}>返回训练系统</button>
              : <button type="button" style={styles.button} onClick={() => setPage("portal")}>返回首页</button>}
          </div>
        </header>

        <RankingBoard rankings={rankings} />

        {bracket.champion && (
          <section style={styles.champion}>
            <div style={{ fontSize: 14 }}>冠军</div>
            <div style={{ fontSize: 28, fontWeight: 800 }}>{playerDisplayName(bracket.champion)}</div>
          </section>
        )}

        {canEditBracket && <section style={styles.panel}>
          <h2 style={{ marginTop: 0, marginBottom: 4 }}>选手名单</h2>
          <div style={{ ...styles.playersGrid, marginTop: 14 }}>
            {bracket.players.map((player) => (
              <div key={player.id} style={{ display: "grid", gridTemplateColumns: activeTraining ? "minmax(0,1fr)" : "minmax(0,1fr) 78px", gap: 6 }}>
                <select
                  value={player.pilotId || ""}
                  onChange={(e) => updatePlayerFromPilot(player.id, e.target.value)}
                  style={styles.input}
                  disabled={!canEditBracket || pilotLibrary.length === 0}
                >
                  <option value="">选择选手</option>
                  {pilotLibrary
                    .filter((pilot) => String(pilot.id) === String(player.pilotId || "") || !selectedPilotIds.has(String(pilot.id)))
                    .map((pilot) => <option key={pilot.id} value={pilot.id}>{pilot.name}{pilot.videoChannel ? ` · ${pilot.videoChannel}` : ""}</option>)}
                </select>
                {!activeTraining && <select
                  aria-label={`${player.name || "未选择选手"} 频点`}
                  value={player.videoChannel || ""}
                  onChange={(e) => updatePlayerFrequency(player.id, e.target.value)}
                  style={{ ...styles.input, padding: "0 5px" }}
                  disabled={!canEditBracket}
                >
                  <option value="">频点</option>
                  {videoChannels.all.map((channel) => <option key={channel} value={channel}>{channel}</option>)}
                </select>}
              </div>
            ))}
          </div>
        </section>}

        <RaceControlCard
          key={currentMatch?.id || "no-current-match"}
          match={currentMatch}
          onRecordLap={recordLap}
          onFinishMatch={finishMatchAndAdvance}
          raceState={raceState}
          onRaceStateChange={updateSyncedRaceState}
          canEdit={canEditBracket}
        />
        <UnifiedBracket key={`${format}-${count}`} bracket={bracket} onResultChange={updateResult} onManualWinner={updateManualWinner} onSelectCurrent={selectCurrentMatch} canEdit={canEditBracket} />
      </div>
    </div>
  );

  if (page === "coachTraining" || page === "coachBracket") {
    return (
      <>
        <div style={{ display: page === "coachTraining" ? "contents" : "none" }} aria-hidden={page !== "coachTraining"}>
          <TrainingPage initialTab="monitor" onBack={() => setPage("portal")} onOpenBracket={() => setPage("coachBracket")} />
        </div>
        {page === "coachBracket" && bracketPage}
      </>
    );
  }

  return bracketPage;
}
