import React, { useEffect, useMemo, useRef, useState } from "react";
import TrainingPage from "./TrainingPage.jsx";
import { TrackAudiencePanel } from "./pages/TrackManagementPage.jsx";

const MATCH_W = 270;
const MATCH_H = 128;
const ROUND_GAP = 42;
const BASE_GAP = 14;
const SECTION_GAP = 14;
const FINALS_GAP = 48;
const API_STATE_URL = "/api/state";
const CANVAS_PAN_PADDING = 80;
const COACH_PASSWORD = "1234";

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
  select: { height: 38, borderRadius: 10, border: "1px solid #d4d4d8", padding: "0 10px", background: "#fff" },
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
  bracketOuter: { width: "100%", height: "calc(100vh - 330px)", minHeight: 520, overflow: "auto", borderRadius: 20, background: "linear-gradient(180deg,#fff,#f8fafc)", border: "1px solid #e4e4e7", position: "relative" },
  bracketPanelFullscreen: { position: "fixed", inset: 0, zIndex: 1000, borderRadius: 0, padding: 18, display: "flex", flexDirection: "column", background: "#fff" },
  bracketOuterFullscreen: { flex: 1, height: "auto", minHeight: 0, borderRadius: 14 },
  bracketCanvas: { position: "relative", transformOrigin: "top left" },
  sectionTitle: { position: "absolute", fontSize: 22, fontWeight: 900, color: "#111827", padding: "6px 12px", borderRadius: 999, background: "#eef2ff", border: "1px solid #c7d2fe" },
  match: { position: "absolute", width: MATCH_W, height: MATCH_H, border: "1px solid #e4e4e7", borderRadius: 14, padding: 10, background: "#fff", boxShadow: "0 8px 18px rgba(15,23,42,.08)", boxSizing: "border-box" },
  matchCurrent: { background: "#fff7ed", border: "2px solid #fdba74", boxShadow: "0 0 0 4px rgba(251,146,60,.18)" },
  matchNext: { background: "#eff6ff", border: "2px solid #93c5fd" },
  matchTie: { background: "#fefce8", border: "2px solid #facc15", boxShadow: "0 0 0 4px rgba(250,204,21,.22)" },
  matchTitle: { fontSize: 13, color: "#71717a", marginBottom: 7, display: "flex", justifyContent: "space-between", gap: 8 },
  row: { display: "grid", gridTemplateColumns: "1fr 124px", gap: 7, alignItems: "center", marginBottom: 7 },
  playerBox: { height: 30, lineHeight: "30px", borderRadius: 9, background: "#fafafa", padding: "0 9px", fontSize: 14, fontWeight: 800, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, maxWidth: "100%", boxSizing: "border-box" },
  resultControls: { display: "grid", gridTemplateColumns: "39px 43px 38px", gap: 2, alignItems: "center" },
  smallInput: { height: 28, borderRadius: 8, border: "1px solid #d4d4d8", textAlign: "center", width: "100%", background: "#fff", boxSizing: "border-box", fontSize: 13, fontWeight: 800 },
  dnfButton: { height: 28, borderRadius: 8, border: "1px solid #d4d4d8", padding: "0 4px", background: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 800 },
  dnfButtonActive: { background: "#fee2e2", border: "1px solid #f87171", color: "#b91c1c", fontWeight: 700 },
  tiePanel: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 4 },
  judgeButton: { height: 26, borderRadius: 8, border: "1px solid #facc15", background: "#fef9c3", color: "#854d0e", cursor: "pointer", fontSize: 12, fontWeight: 800 },
  champion: { borderRadius: 24, background: "linear-gradient(135deg,#ecfdf5,#d1fae5)", color: "#047857", padding: 22, boxShadow: "0 14px 30px rgba(5,150,105,.16)", border: "1px solid #a7f3d0" },
  rankingPanel: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 10, marginTop: 14 },
  rankingItem: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, borderRadius: 14, background: "#f8fafc", border: "1px solid #e2e8f0", padding: "10px 12px", fontSize: 14 },
  rankBadge: { minWidth: 42, height: 26, borderRadius: 999, background: "#e0e7ff", color: "#3730a3", display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: 900 },
};

function nextPowerOfTwo(n) { let p = 1; while (p < n) p *= 2; return p; }
function makeId(group, round, index) { return `${group}-${round}-${index}`; }
function blankResult() { return { laps: "", seconds: "", dnf: false }; }
function cloneResult(result) { return result ? { ...result } : blankResult(); }
function clonePlayer(player) { return player ? { ...player } : null; }

function createPlayers(count) {
  return Array.from({ length: count }, (_, index) => ({ id: `P${index + 1}`, seed: index + 1, name: `选手 ${index + 1}` }));
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

function createMatch(group, round, index, titlePrefix) {
  return {
    id: makeId(group, round, index),
    group,
    round,
    index,
    title: `${titlePrefix} R${round + 1}-${index + 1}`,
    slots: [null, null],
    results: [blankResult(), blankResult()],
    manualWinnerSlot: null,
    isTie: false,
    winner: null,
    loser: null,
    winnerTarget: null,
    loserTarget: null,
  };
}

function cloneMatch(match) {
  return {
    ...match,
    slots: match.slots.map(clonePlayer),
    results: match.results ? match.results.map(cloneResult) : [blankResult(), blankResult()],
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
    { id: "GF-1", group: "F", round: 1, index: 0, title: "重置加赛", slots: [null, null], results: [blankResult(), blankResult()], manualWinnerSlot: null, isTie: false, winner: null, loser: null, winnerTarget: null, loserTarget: null, optional: true },
  ];

  wireRoutes(winners, losers, finals);
  syncFirstRoundPlayers({ size, players, winners });
  return { size, playerCount: safeCount, players, winners, losers, finals, champion: null };
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
    players: raw.players.map(clonePlayer),
    winners: raw.winners.map((round) => round.map(cloneMatch)),
    losers: raw.losers.map((round) => round.map(cloneMatch)),
    finals: raw.finals.map(cloneMatch),
    champion: clonePlayer(raw.champion),
  };
}

function allMatches(bracket) { return [...bracket.winners.flat(), ...bracket.losers.flat(), ...bracket.finals]; }
function findMatch(bracket, matchId) { return allMatches(bracket).find((match) => match.id === matchId); }

function syncFirstRoundPlayers(bracket) {
  const seededSlots = createSeededSlots(bracket.players, bracket.size);
  for (let index = 0; index < bracket.winners[0].length; index += 1) {
    bracket.winners[0][index].slots = [seededSlots[index * 2], seededSlots[index * 2 + 1]];
  }
}

function clearGeneratedSlots(bracket) {
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

function makeStructuralBye(sourceMatch, target) { return { id: `LB-BYE-${sourceMatch.id}-${target.matchId}-${target.slot}`, name: "BYE", bye: true, structuralBye: true }; }
function makeAdvanceBye(sourceMatch, target) { return { id: `ADV-BYE-${sourceMatch.id}-${target.matchId}-${target.slot}`, name: "BYE", bye: true, structuralBye: true }; }
function isRealPlayer(player) { return Boolean(player && !player.bye); }
function matchHasRealVsBye(match) { const [a, b] = match.slots; return Boolean(a && b && ((a.bye && !b.bye) || (b.bye && !a.bye))); }
function matchHasByeVsBye(match) { const [a, b] = match.slots; return Boolean(a && b && a.bye && b.bye); }
function hasAnyResultInput(result) { return Boolean(result?.dnf || result?.laps !== "" || result?.seconds !== ""); }

function normalizeResult(result) {
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

function recomputeBracket(raw) {
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
  annotateMatchHighlights(bracket);
  return bracket;
}

function isPlayableMatch(match) { const [a, b] = match.slots; return Boolean(isRealPlayer(a) && isRealPlayer(b) && !match.winner); }
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
function getSingleCurrentMatch(bracket) { return getPlayableQueue(bracket)[0] || null; }

function annotateMatchHighlights(bracket) {
  clearHighlights(bracket);
  const [current, next] = getPlayableQueue(bracket);
  if (current) current.highlight = "current";
  if (next) next.highlight = "next1";
}

function getMatchHighlightStyle(match) {
  if (match.isTie && !match.winner) return styles.matchTie;
  if (match.highlight === "current") return styles.matchCurrent;
  if (match.highlight === "next1") return styles.matchNext;
  return {};
}

function getEliminationRecords(bracket) {
  const records = [];
  let order = 0;
  for (const match of bracketOrderMatches(bracket)) {
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
  return bracket.players.map((player) => {
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
  if (match.winner?.id === player.id) return { color: "#047857", fontWeight: 700 };
  if (match.loser?.id === player.id) return { color: "#71717a", textDecoration: "line-through" };
  return { color: "#18181b" };
}

function ResultControls({ result, disabled, onChange }) {
  const dnf = Boolean(result.dnf);
  const laps = dnf ? "" : result.laps;
  const seconds = dnf ? "" : result.seconds;
  return (
    <div style={styles.resultControls}>
      <select disabled={disabled || dnf} value={laps} onChange={(e) => onChange({ ...result, laps: e.target.value, seconds: e.target.value === "0" ? "0" : result.seconds })} style={{ ...styles.smallInput, opacity: disabled || dnf ? 0.45 : 1 }} title="圈数">
        <option value="">圈</option><option value="0">0</option><option value="1">1</option><option value="2">2</option><option value="3">3</option>
      </select>
      <input disabled={disabled || dnf || result.laps === "0"} value={result.laps === "0" ? "0" : seconds} onChange={(e) => { if (/^\d*(\.\d*)?$/.test(e.target.value)) onChange({ ...result, seconds: e.target.value }); }} placeholder="秒" style={{ ...styles.smallInput, opacity: disabled || dnf || result.laps === "0" ? 0.45 : 1 }} inputMode="decimal" title="秒数" />
      <button type="button" disabled={disabled} onClick={() => onChange(dnf ? blankResult() : { laps: "", seconds: "", dnf: true })} style={{ ...styles.dnfButton, ...(dnf ? styles.dnfButtonActive : {}), opacity: disabled ? 0.45 : 1 }}>DNF</button>
    </div>
  );
}

function MatchCard({ match, x, y, onResultChange, onManualWinner, canEdit }) {
  const [a, b] = match.slots;
  const disabled = !canEdit || !a || !b || a.bye || b.bye;
  return (
    <div data-no-pan="true" style={{ ...styles.match, ...getMatchHighlightStyle(match), left: x, top: y }}>
      <div style={styles.matchTitle}><span>{match.title}</span><span>{match.id}</span></div>
      {[a, b].map((player, index) => (
        <div key={`${match.id}-${index}`} style={{ ...styles.row, minWidth: 0 }}>
          <div style={{ ...styles.playerBox, ...getPlayerTextStyle(match, player) }}>{player?.name || "待定"}</div>
          <ResultControls result={match.results[index]} disabled={disabled} onChange={(nextResult) => onResultChange(match.id, index, nextResult)} />
        </div>
      ))}
      {canEdit && match.isTie && isRealPlayer(a) && isRealPlayer(b) && !match.winner && (
        <div style={styles.tiePanel}>
          <button type="button" style={styles.judgeButton} onClick={() => onManualWinner(match.id, 0)}>判 {a.name} 胜</button>
          <button type="button" style={styles.judgeButton} onClick={() => onManualWinner(match.id, 1)}>判 {b.name} 胜</button>
        </div>
      )}
    </div>
  );
}

function layoutRounds(rounds, mode, offsetX, offsetY) {
  const positions = new Map();
  let height = 0;
  rounds.forEach((round, roundIndex) => {
    const x = offsetX + roundIndex * (MATCH_W + ROUND_GAP);
    const spreadPower = mode === "winner" ? roundIndex : Math.floor(roundIndex / 2);
    const block = MATCH_H + BASE_GAP + spreadPower * 10;
    height = Math.max(height, round.length * block);
    round.forEach((match, matchIndex) => positions.set(match.id, { x, y: offsetY + matchIndex * block + spreadPower * 18, w: MATCH_W, h: MATCH_H, match }));
  });
  return { positions, width: rounds.length * MATCH_W + Math.max(0, rounds.length - 1) * ROUND_GAP, height: Math.max(height + 50, 240) };
}

function layoutFinals(finals, offsetX, offsetY) {
  const positions = new Map();
  finals.forEach((match, index) => positions.set(match.id, { x: offsetX, y: offsetY + index * (MATCH_H + 36), w: MATCH_W, h: MATCH_H, match }));
  return { positions, width: MATCH_W, height: finals.length * MATCH_H + 60 };
}

function connectorPath(from, to, slot = 0) {
  const x1 = from.x + from.w;
  const y1 = from.y + from.h / 2;
  const x2 = to.x;
  const y2 = to.y + (slot === 0 ? to.h * 0.34 : to.h * 0.68);
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
            <strong style={{ flex: 1 }}>{item.player.name}</strong>
            <span style={{ color: item.status === "冠军" ? "#047857" : "#64748b", fontSize: 12 }}>{item.status}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function UnifiedBracket({ bracket, onResultChange, onManualWinner, zoom, setZoom, canEdit }) {
  const sectionRef = React.useRef(null);
  const outerRef = React.useRef(null);
  const dragRef = React.useRef({ active: false, x: 0, y: 0, left: 0, top: 0 });
  const [fullscreen, setFullscreen] = useState(false);
  const layout = buildUnifiedLayout(bracket);
  const matches = allMatches(bracket);
  const viewportW = typeof window !== "undefined" ? Math.max(900, window.innerWidth - (fullscreen ? 36 : 90)) : 1400;
  const viewportH = typeof window !== "undefined" ? Math.max(520, window.innerHeight - (fullscreen ? 145 : 350)) : 720;
  const availableW = viewportW - 60;
  const availableH = viewportH - 40;
  const fitZoom = Math.min(1, availableW / layout.width, availableH / layout.height);
  const actualZoom = zoom === "fit" ? fitZoom : zoom;
  const scaledWidth = layout.width * actualZoom;
  const scaledHeight = layout.height * actualZoom;
  const baseWrapperWidth = zoom === "fit" ? Math.max(availableW, scaledWidth) : scaledWidth;
  const baseWrapperHeight = zoom === "fit" ? Math.max(availableH, scaledHeight) : scaledHeight;
  const wrapperWidth = baseWrapperWidth + CANVAS_PAN_PADDING * 2;
  const wrapperHeight = baseWrapperHeight + CANVAS_PAN_PADDING * 2;
  const offsetX = CANVAS_PAN_PADDING + (zoom === "fit" ? Math.max(0, (baseWrapperWidth - scaledWidth) / 2) : 0);
  const offsetY = CANVAS_PAN_PADDING + (zoom === "fit" ? Math.max(0, (baseWrapperHeight - scaledHeight) / 2) : 0);
  const lines = matches.map((match) => {
    if (!match.winnerTarget) return null;
    const from = layout.positions.get(match.id);
    const to = layout.positions.get(match.winnerTarget.matchId);
    return from && to ? { id: `${match.id}->${match.winnerTarget.matchId}`, path: connectorPath(from, to, match.winnerTarget.slot) } : null;
  }).filter(Boolean);

  useEffect(() => {
    if (!outerRef.current) return;
    outerRef.current.scrollLeft = CANVAS_PAN_PADDING;
    outerRef.current.scrollTop = CANVAS_PAN_PADDING;
  }, [layout.width, layout.height, actualZoom]);

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
    setZoom("fit");
  }

  function handlePointerDown(event) {
    if (!outerRef.current) return;
    if (event.target.closest?.('[data-no-pan="true"]')) return;
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
    if (!dragRef.current.active || !outerRef.current) return;
    const dx = event.clientX - dragRef.current.x;
    const dy = event.clientY - dragRef.current.y;
    outerRef.current.scrollLeft = dragRef.current.left - dx;
    outerRef.current.scrollTop = dragRef.current.top - dy;
  }

  function handlePointerUp() {
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
              <span style={{ color: "#2563eb" }}>浅蓝＝下一场比赛</span>
              <span style={{ color: "#a16207" }}>黄色＝平局待裁定</span>
            </div>
            <div style={styles.legendRow}>
              <span style={styles.legendStrong}>结果：</span>
              <span>绿色加粗＝胜者</span>
              <span>灰色划线＝败者</span>
              <span>BYE＝轮空自动晋级</span>
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
          <button type="button" style={{ ...styles.button, ...styles.primaryButton }} onClick={() => setZoom("fit")}>适应窗口</button>
          <button type="button" style={styles.button} onClick={() => setZoom((z) => Math.max(0.35, (z === "fit" ? fitZoom : z) - 0.1))}>−</button>
          <span style={{ fontWeight: 900, minWidth: 58, textAlign: "center" }}>{Math.round(actualZoom * 100)}%</span>
          <button type="button" style={styles.button} onClick={() => setZoom((z) => Math.min(1.8, (z === "fit" ? fitZoom : z) + 0.1))}>＋</button>
          <button type="button" style={styles.button} onClick={() => setZoom(1)}>100%</button>
          <button type="button" style={styles.button} onClick={toggleFullscreen}>{fullscreen ? "退出全屏" : "全屏显示"}</button>
        </div>
      </div>
      <div
        ref={outerRef}
        style={{ ...styles.bracketOuter, ...(fullscreen ? styles.bracketOuterFullscreen : {}), cursor: "grab" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <div style={{ width: wrapperWidth, height: wrapperHeight, position: "relative", margin: "0 auto" }}>
          <div style={{ ...styles.bracketCanvas, width: layout.width, height: layout.height, transform: `translate(${offsetX}px, ${offsetY}px) scale(${actualZoom})` }}>
            <svg width={layout.width} height={layout.height} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
              {lines.map((line) => <path key={line.id} d={line.path} fill="none" stroke="#94a3b8" strokeWidth="2.5" />)}
            </svg>
            {layout.titles.map((title) => <div key={title.text} style={{ ...styles.sectionTitle, left: title.x, top: title.y }}>{title.text}</div>)}
            {matches.map((match) => {
              const pos = layout.positions.get(match.id);
              return pos ? <MatchCard key={match.id} match={match} x={pos.x} y={pos.y} onResultChange={onResultChange} onManualWinner={onManualWinner} canEdit={canEdit} /> : null;
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

function runSelfTests() {
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
  console.assert(allMatches(highlightBracket).filter((match) => match.highlight === "current").length === 1, "当前可进行比赛应只高亮一场");
  console.assert(allMatches(highlightBracket).filter((match) => match.highlight === "next1").length === 1, "下一场比赛应只高亮一场");
  console.assert(getSingleCurrentMatch(highlightBracket)?.id === "W-0-0", "初始当前比赛应为第一列最上方比赛");

  const rankings = getRankings(recomputeBracket(createEmptyBracket(8)));
  console.assert(rankings.length === 8, "排名列表应包含所有真实选手");
  console.assert(rankings.every((item) => item.rank === "未定"), "没有二败淘汰前，所有排名都应为未定");
}

if (typeof window !== "undefined" && !window.__DOUBLE_ELIMINATION_TESTED_V7__) {
  window.__DOUBLE_ELIMINATION_TESTED_V7__ = true;
  runSelfTests();
}

export default function DoubleEliminationBracket() {
  const [page, setPage] = useState("portal");
  const [coachPassword, setCoachPassword] = useState("");
  const [coachError, setCoachError] = useState("");
  const [count, setCount] = useState(8);
  const [rawBracket, setRawBracket] = useState(() => createEmptyBracket(8));
  const [pilotLibrary, setPilotLibrary] = useState([]);
  const [zoom, setZoom] = useState("fit");
  const [saveStatus, setSaveStatus] = useState("未连接服务器");
  const saveTimerRef = useRef(null);
  const canEditBracket = page === "coachBracket";
  const isBracketPage = page === "bracket" || page === "coachBracket";

  const bracket = useMemo(() => recomputeBracket(rawBracket), [rawBracket]);
  const rankings = useMemo(() => getRankings(bracket), [bracket]);

  useEffect(() => {
    if (!isBracketPage) return undefined;
    let stopped = false;
    async function loadPilots() {
      try {
        const response = await fetch("/api/pilots", { cache: "no-store" });
        if (!response.ok) throw new Error("读取飞手库失败");
        const pilots = await response.json();
        if (!stopped) setPilotLibrary(Array.isArray(pilots) ? pilots : []);
      } catch {
        if (!stopped) setPilotLibrary([]);
      }
    }
    loadPilots();
    return () => {
      stopped = true;
    };
  }, [isBracketPage]);

  function applySavedState(saved) {
    if (!saved || !saved.rawBracket) return;
    const nextBracket = saved.rawBracket;
    setRawBracket(nextBracket);
    setCount(Number(saved.count || nextBracket.playerCount || 8));
  }

  function scheduleSave(nextRawBracket, nextCount = count) {
    if (!canEditBracket) return;
    setSaveStatus("正在保存...");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      try {
        await saveStateToServer({ count: nextCount, rawBracket: nextRawBracket, updatedAt: new Date().toISOString() });
        setSaveStatus("已保存到服务器 JSON");
      } catch {
        setSaveStatus("保存失败：请确认后端已启动");
      }
    }, 250);
  }

  function commitRawBracket(updater, nextCount = count) {
    setRawBracket((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      scheduleSave(next, nextCount);
      return next;
    });
  }

  useEffect(() => {
    if (!isBracketPage) return undefined;
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
  }, [canEditBracket, isBracketPage]);

  function resetByCount(newCount) {
    if (!canEditBracket) return;
    const nextCount = Number(newCount);
    const nextBracket = createEmptyBracket(nextCount);
    setCount(nextCount);
    commitRawBracket(nextBracket, nextCount);
    setZoom("fit");
  }

  function updatePlayerFromPilot(id, pilotId) {
    if (!canEditBracket) return;
    const pilot = pilotLibrary.find((item) => item.id === pilotId);
    commitRawBracket((prev) => ({
      ...prev,
      players: prev.players.map((player) => (
        player.id === id
          ? { ...player, pilotId, name: pilot?.name || player.name }
          : player
      )),
    }));
  }

  function updateResult(matchId, slotIndex, nextResult) {
    if (!canEditBracket) return;
    commitRawBracket((prev) => {
      const next = cloneBracket(prev);
      const match = findMatch(next, matchId);
      if (!match) return prev;
      const normalized = { ...nextResult };
      if (normalized.dnf) { normalized.laps = ""; normalized.seconds = ""; }
      if (normalized.laps === "0") normalized.seconds = "0";
      match.results[slotIndex] = normalized;
      match.manualWinnerSlot = null;
      return next;
    });
  }

  function updateManualWinner(matchId, slotIndex) {
    if (!canEditBracket) return;
    commitRawBracket((prev) => {
      const next = cloneBracket(prev);
      const match = findMatch(next, matchId);
      if (!match) return prev;
      match.manualWinnerSlot = slotIndex;
      return next;
    });
  }

  async function handleManualSave() {
    if (!canEditBracket) return;
    try {
      setSaveStatus("正在手动保存...");
      await saveStateToServer({ count, rawBracket, updatedAt: new Date().toISOString() });
      setSaveStatus("已手动保存到服务器 JSON");
    } catch {
      setSaveStatus("手动保存失败：请确认后端已启动，并且访问的是 3000 端口");
    }
  }

  function enterCoachMode(event) {
    event.preventDefault();
    if (coachPassword !== COACH_PASSWORD) {
      setCoachError("密码不正确");
      return;
    }
    setCoachPassword("");
    setCoachError("");
    setPage("coachTraining");
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
              >🛤️ 训练赛道</button>
              <button type="button"
                onClick={() => setPage("publicMonitor")}
                style={{ height: 72, borderRadius: 16, border: "none", padding: "0 24px", cursor: "pointer", fontWeight: 800, fontSize: 16, background: "linear-gradient(135deg, #0ea5e9 0%, #06b6d4 50%, #10b981 100%)", color: "#fff", boxShadow: "0 8px 32px rgba(14,165,233,.35)", transition: "transform .15s, box-shadow .15s" }}
                onMouseEnter={(e) => { e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = "0 14px 40px rgba(14,165,233,.45)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.transform = "translateY(0)"; e.currentTarget.style.boxShadow = "0 8px 32px rgba(14,165,233,.35)"; }}
              >📡 训练状态监测</button>
              <button type="button"
                onClick={() => setPage("bracket")}
                style={{ height: 72, borderRadius: 16, border: "none", padding: "0 24px", cursor: "pointer", fontWeight: 800, fontSize: 16, background: "linear-gradient(135deg, #f59e0b 0%, #ef4444 100%)", color: "#fff", boxShadow: "0 8px 32px rgba(245,158,11,.35)", transition: "transform .15s, box-shadow .15s" }}
                onMouseEnter={(e) => { e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = "0 14px 40px rgba(245,158,11,.45)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.transform = "translateY(0)"; e.currentTarget.style.boxShadow = "0 8px 32px rgba(245,158,11,.35)"; }}
              >🏆 模拟双败淘汰赛</button>
            </div>
            <button type="button" style={{ ...styles.button, height: 44, background: "#f8fafc", color: "#64748b" }} onClick={() => { setCoachPassword(""); setCoachError(""); setPage("coachLogin"); }}>
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
    return <TrainingPage audience initialTab="monitor" onBack={() => setPage("portal")} />;
  }

  if (page === "trackDisplay") {
    return (
      <div style={styles.page}>
        <div style={{ ...styles.container, maxWidth: 1500 }}>
          <header style={{ ...styles.panel, ...styles.header }}>
            <div>
              <h1 style={styles.title}>训练赛道</h1>
              <div style={styles.subtitle}>展示当前训练赛道、器材统计和当前选中的搬运方案。</div>
            </div>
            <button type="button" style={styles.button} onClick={() => setPage("portal")}>返回首页</button>
          </header>
          <TrackAudiencePanel showEmpty />
        </div>
      </div>
    );
  }

  if (page === "coachTraining") {
    return <TrainingPage initialTab="monitor" onBack={() => setPage("portal")} onOpenBracket={() => setPage("coachBracket")} />;
  }
  
  return (
    <div style={styles.page}>
      <div style={styles.container}>
        <header style={{ ...styles.panel, ...styles.header }}>
          <div>
            <h1 style={styles.title}>双败淘汰赛对阵表</h1>
            <div style={styles.subtitle}>
              状态：{saveStatus}
            </div>
          </div>
          <div style={styles.controls}>
            <span style={{ fontWeight: 900, color: canEditBracket ? "#2563eb" : "#64748b" }}>当前：{canEditBracket ? "教练模式" : "观众页"}</span>
            {canEditBracket && <button type="button" style={styles.button} onClick={() => setPage("coachTraining")}>训练系统</button>}
            <button type="button" style={styles.button} onClick={() => setPage("portal")}>返回首页</button>
            {canEditBracket && <button type="button" style={{ ...styles.button, ...styles.primaryButton }} onClick={handleManualSave}>立即保存</button>}
            <label htmlFor="player-count">参赛人数</label>
            <select id="player-count" value={count} onChange={(e) => resetByCount(e.target.value)} style={styles.select} disabled={!canEditBracket}>
              {Array.from({ length: 13 }, (_, index) => index + 4).map((number) => <option key={number} value={number}>{number} 人</option>)}
            </select>
            <button type="button" style={styles.button} onClick={() => resetByCount(count)} disabled={!canEditBracket}>重置</button>
          </div>
        </header>

        <section style={styles.panel}>
          <h2 style={{ marginTop: 0 }}>选手名单</h2>
          <div style={{ ...styles.playersGrid, marginTop: 14 }}>
            {bracket.players.map((player) => (
              <select
                key={player.id}
                value={player.pilotId || ""}
                onChange={(e) => updatePlayerFromPilot(player.id, e.target.value)}
                style={styles.input}
                disabled={!canEditBracket || pilotLibrary.length === 0}
              >
                <option value="">{player.name}</option>
                {pilotLibrary.map((pilot) => <option key={pilot.id} value={pilot.id}>{pilot.name}</option>)}
              </select>
            ))}
          </div>
        </section>

        {bracket.champion && (
          <section style={styles.champion}>
            <div style={{ fontSize: 14 }}>冠军</div>
            <div style={{ fontSize: 28, fontWeight: 800 }}>{bracket.champion.name}</div>
          </section>
        )}

        <UnifiedBracket bracket={bracket} onResultChange={updateResult} onManualWinner={updateManualWinner} zoom={zoom} setZoom={setZoom} canEdit={canEditBracket} />
        <RankingBoard rankings={rankings} />
      </div>
    </div>
  );
}
