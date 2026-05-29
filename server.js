import express from "express";
import { Buffer } from "node:buffer";
import fs from "fs";
import http from "http";
import path from "path";
import crypto from "crypto";
import { DatabaseSync } from "node:sqlite";
const app = express();
const server = http.createServer(app);
const PORT = 3000;

const DEFAULT_TRANSPORT_RULES = {
  single: { name: "单门", qty: 4, people: 1, cart: 1, minutes: 10, difficulty: 2, enabled: true, note: "小车搬运，支持 4/5 个、1/2 人候选" },
  sun: { name: "日字门", qty: 2, people: 1, cart: 0, minutes: 8, difficulty: 4, enabled: true, note: "支持 1/2 人候选" },
  gravity: { name: "重力门", qty: 1, people: 1, cart: 0, minutes: 8, difficulty: 1, enabled: true, note: "自带轮子" },
  doubleGravity: { name: "双层重力门", qty: 1, people: 2, cart: 0, minutes: 10, difficulty: 5, enabled: true, note: "固定 2 人" },
  triple: { name: "三层门", qty: 1, people: 1, cart: 0, minutes: 15, difficulty: 3, enabled: true, note: "固定 1 人，有轮子" },
  flag: { name: "刀旗", qty: 4, people: 1, cart: 0, minutes: 4, difficulty: 1, enabled: true, note: "轻量器材" },
};

const DEFAULT_TRANSPORT_PARAMS = {
  singleQtyNormal: 4,
  singleQtyMax: 5,
  singleTwoPeopleCoef: 0.9,
  singleFiveCoef: 1.15,
  sunTwoPeopleCoef: 0.85,
  sunSandPerGate: 2,
  singleSandPerGate: 2,
  sandHandQty: 2,
  sandHandTime: 6,
  sandCartQty: 6,
  sandCartTime: 5,
  wTime: 100,
  wIdle: 80,
  wFatigue: 18,
  wHardStreak: 25,
  wTripBalance: 45,
};

function plannerNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function plannerClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeTransportConfig(input = {}) {
  const rules = plannerClone(DEFAULT_TRANSPORT_RULES);
  for (const [key, rule] of Object.entries(input.rules || {})) {
    if (rules[key]) rules[key] = { ...rules[key], ...rule };
  }
  return {
    counts: { single: 0, sun: 0, gravity: 0, doubleGravity: 0, triple: 0, sandbag: 0, flag: 0, ...(input.counts || {}) },
    peopleStart: Math.max(1, Math.min(7, Math.floor(plannerNumber(input.peopleStart, 5)))),
    carts: Math.max(0, Math.floor(plannerNumber(input.carts, 1))),
    maxTrips: Math.max(1, Math.floor(plannerNumber(input.maxTrips, 3))),
    nodeLimit: Math.max(2000, Math.floor(plannerNumber(input.nodeLimit, 1000000))),
    wind: Boolean(input.wind),
    sandbags: input.sandbags === null || input.sandbags === undefined || input.sandbags === "" ? null : Math.max(0, Math.floor(plannerNumber(input.sandbags, 0))),
    rules,
    params: { ...DEFAULT_TRANSPORT_PARAMS, ...(input.params || {}) },
  };
}

function splitPlannerTrips(total, cap) {
  const trips = [];
  let rest = Math.max(0, Math.floor(total));
  const safeCap = Math.max(1, Math.floor(cap));
  while (rest > 0) {
    const qty = Math.min(safeCap, rest);
    trips.push(qty);
    rest -= qty;
  }
  return trips;
}

function splitEquipmentTrips(total, normalCap, maxCap) {
  const result = [];
  let rest = Math.max(0, Math.floor(total));
  const preferred = Math.max(1, Math.floor(maxCap || normalCap || 1));
  while (rest > 0) {
    const qty = Math.min(preferred, rest);
    result.push(qty);
    rest -= qty;
  }
  return result;
}

function makeTransportJob(name, type, qty, alts, deps = []) {
  return { id: `${type}_${name}_${Math.random().toString(36).slice(2)}`, name, type, qty, alts, deps };
}

function buildTransportJobs(cfg, sandMode = "mixed") {
  const jobs = [];
  const sandNeeds = [];
  const rules = cfg.rules;
  const params = cfg.params;
  const counts = cfg.counts;

  splitEquipmentTrips(counts.single, params.singleQtyNormal, params.singleQtyMax).forEach((qty, index) => {
    const name = `单门#${index + 1}`;
    const id = `single_${index + 1}`;
    jobs.push({
      id,
      name,
      type: "single",
      qty,
      alts: [
        { name, type: "single", qty, people: 1, cart: Math.max(0, Math.floor(rules.single.cart)), minutes: rules.single.minutes * (qty >= params.singleQtyMax ? params.singleFiveCoef : 1), difficulty: rules.single.difficulty, tripCost: 1 },
        { name, type: "single", qty, people: 2, cart: Math.max(0, Math.floor(rules.single.cart)), minutes: rules.single.minutes * params.singleTwoPeopleCoef * (qty >= params.singleQtyMax ? params.singleFiveCoef : 1), difficulty: rules.single.difficulty, tripCost: 1 },
      ],
    });
    if (cfg.wind) sandNeeds.push({ dep: id, target: name, count: qty * Math.max(0, Math.floor(params.singleSandPerGate)) });
  });

  splitEquipmentTrips(counts.sun, rules.sun.qty || 2, rules.sun.qty || 2).forEach((qty, index) => {
    const name = `日字门#${index + 1}`;
    const id = `sun_${index + 1}`;
    jobs.push({
      id,
      name,
      type: "sun",
      qty,
      alts: [
        { name, type: "sun", qty, people: 1, cart: Math.max(0, Math.floor(rules.sun.cart)), minutes: rules.sun.minutes, difficulty: rules.sun.difficulty, tripCost: 1 },
        { name, type: "sun", qty, people: 2, cart: Math.max(0, Math.floor(rules.sun.cart)), minutes: rules.sun.minutes * params.sunTwoPeopleCoef, difficulty: rules.sun.difficulty, tripCost: 1 },
      ],
    });
    sandNeeds.push({ dep: id, target: name, count: qty * Math.max(0, Math.floor(params.sunSandPerGate)) });
  });

  for (const type of ["gravity", "doubleGravity", "triple", "flag"]) {
    const rule = rules[type];
    if (rule?.enabled === false) continue;
    for (let index = 0; index < Math.max(0, Math.floor(plannerNumber(counts[type], 0))); index += 1) {
      const name = `${rule.name}#${index + 1}`;
      jobs.push(makeTransportJob(name, type, 1, [
        { name, type, qty: 1, people: Math.max(1, Math.floor(rule.people)), cart: Math.max(0, Math.floor(rule.cart)), minutes: rule.minutes, difficulty: rule.difficulty, tripCost: 1 },
      ]));
    }
  }

  const autoSand = sandNeeds.reduce((sum, item) => sum + item.count, 0);
  const requestedSand = cfg.sandbags === null ? Math.max(autoSand, Math.max(0, Math.floor(plannerNumber(counts.sandbag, 0)))) : cfg.sandbags;
  if (requestedSand > autoSand) sandNeeds.push({ dep: "", target: "沙包", count: requestedSand - autoSand });

  let sandIndex = 0;
  for (const need of sandNeeds) {
    const canUseCart = cfg.carts > 0 && sandMode !== "hand";
    const mode = sandMode === "cart" && canUseCart ? "cart" : sandMode === "hand" ? "hand" : canUseCart ? "cart" : "hand";
    const cap = mode === "cart" ? params.sandCartQty : params.sandHandQty;
    const minutes = mode === "cart" ? params.sandCartTime : params.sandHandTime;
    const label = mode === "cart" ? "小车" : "手提";
    let previous = need.dep;
    splitPlannerTrips(need.count, cap).forEach((qty) => {
      sandIndex += 1;
      const name = `沙包-${label}#${sandIndex} 对应 ${need.target}`;
      const id = `sand_${sandIndex}`;
      jobs.push({
        id,
        name,
        type: "sandbag",
        qty,
        deps: previous ? [previous] : [],
        alts: [{ name, type: "sandbag", qty, people: 1, cart: mode === "cart" ? 1 : 0, minutes, difficulty: 2.5, tripCost: 1 }],
      });
      previous = id;
    });
  }

  return jobs;
}

function plannerCombos(items, size) {
  const result = [];
  function rec(start, picked) {
    if (picked.length === size) {
      result.push(picked.slice());
      return;
    }
    for (let index = start; index < items.length; index += 1) {
      picked.push(items[index]);
      rec(index + 1, picked);
      picked.pop();
    }
  }
  rec(0, []);
  return result;
}

function scheduleTransportJobs(jobs, peopleCount, cfg) {
  const people = Array.from({ length: peopleCount }, (_, index) => ({ id: index + 1, t: 0, trips: 0, fatigue: 0, lastDifficulty: 0, jobs: [] }));
  const carts = Array.from({ length: cfg.carts }, (_, index) => ({ id: index + 1, t: 0 }));
  const doneAt = new Map();
  let totalIdle = 0;
  let hardStreak = 0;
  let nodes = 0;

  for (const job of jobs) {
    const depReady = (job.deps || []).reduce((max, dep) => Math.max(max, doneAt.get(dep) || 0), 0);
    let best = null;
    for (const alt of job.alts) {
      if (alt.cart > cfg.carts) continue;
      const available = people.filter((person) => person.trips + alt.tripCost <= cfg.maxTrips);
      for (const group of plannerCombos(available, alt.people)) {
        nodes += 1;
        let cart = null;
        let cartReady = 0;
        if (alt.cart > 0) {
          if (!carts.length) continue;
          cart = carts.slice().sort((left, right) => left.t - right.t)[0];
          cartReady = cart.t;
        }
        const peopleReady = Math.max(0, ...group.map((person) => person.t));
        const start = Math.max(depReady, cartReady, peopleReady);
        const idle = group.reduce((sum, person) => sum + Math.max(0, start - person.t), 0);
        const streak = group.reduce((sum, person) => sum + (person.lastDifficulty >= 4 && alt.difficulty >= 4 ? 1 : 0), 0);
        const end = start + alt.minutes;
        const localScore = end * cfg.params.wTime + idle * cfg.params.wIdle + streak * cfg.params.wHardStreak + alt.difficulty * cfg.params.wFatigue;
        if (!best || localScore < best.localScore) best = { alt, group, cart, start, end, idle, streak, localScore };
      }
    }
    if (!best) return null;
    const groupKey = best.group.map((person) => person.id).sort((a, b) => a - b).join("+");
    const assigned = {
      ...best.alt,
      start: best.start,
      end: best.end,
      peopleIds: best.group.map((person) => person.id),
      groupKey,
      cartId: best.cart?.id || null,
    };
    for (const person of best.group) {
      person.t = best.end;
      person.trips += best.alt.tripCost;
      person.fatigue += best.alt.difficulty * best.alt.tripCost;
      person.lastDifficulty = best.alt.difficulty;
      person.jobs.push(assigned);
    }
    if (best.cart) best.cart.t = best.end;
    doneAt.set(job.id, best.end);
    totalIdle += best.idle;
    hardStreak += best.streak;
  }

  const makespan = Math.max(0, ...people.map((person) => person.t));
  const fatigue = people.reduce((sum, person) => sum + person.fatigue, 0);
  const active = people.filter((person) => person.trips > 0);
  const avgTrips = active.length ? active.reduce((sum, person) => sum + person.trips, 0) / active.length : 0;
  const tripImbalance = active.reduce((sum, person) => sum + (person.trips - avgTrips) ** 2, 0);
  const plan = {
    people,
    makespan,
    totalIdle,
    hardStreak,
    fatigue,
    tripImbalance,
    peopleCount,
    usedCount: active.length,
    nodes,
  };
  plan.score = makespan * cfg.params.wTime + totalIdle * cfg.params.wIdle + fatigue * cfg.params.wFatigue + hardStreak * cfg.params.wHardStreak + tripImbalance * cfg.params.wTripBalance;
  plan.ruleSummary = "按器材规则、沙包分趟和协作任务生成";
  plan.proven = true;
  return plan;
}

function calculateTransportPlans(input = {}) {
  const cfg = normalizeTransportConfig(input);
  const result = bbCalculateTransportPlans(cfg);
  return result;
}

// ── 分支定界搬运规划器（内联自 transportPlanner.js）──────────────────────────

const BB_DEFAULT_TRANSPORT_RULES = {
  single: { name: "单门", qty: 4, people: 1, cart: 1, minutes: 10, difficulty: 2, enabled: true, note: "小车搬运，支持 4/5 个、1/2 人候选" },
  sun: { name: "日字门", qty: 2, people: 1, cart: 0, minutes: 8, difficulty: 4, enabled: true, note: "支持 1/2 人候选" },
  gravity: { name: "重力门", qty: 1, people: 1, cart: 0, minutes: 8, difficulty: 1, enabled: true, note: "自带轮子" },
  doubleGravity: { name: "双层重力门", qty: 1, people: 2, cart: 0, minutes: 10, difficulty: 5, enabled: true, note: "固定 2 人" },
  triple: { name: "三层门", qty: 1, people: 1, cart: 0, minutes: 15, difficulty: 3, enabled: true, note: "固定 1 人，有轮子" },
  flag: { name: "刀旗", qty: 4, people: 1, cart: 0, minutes: 4, difficulty: 1, enabled: true, note: "轻量器材" },
};

const BB_DEFAULT_TRANSPORT_CONFIG = {
  counts: { single: 0, sun: 0, gravity: 0, doubleGravity: 0, triple: 0, flag: 0, sandbag: 0 },
  peopleStart: 5,
  carts: 1,
  maxTrips: 3,
  nodeLimit: 1000000,
  wind: false,
  sandbags: null,
  rules: BB_DEFAULT_TRANSPORT_RULES,
  params: {
    singleQtyNormal: 4, singleQtyMax: 5,
    singleTwoPeopleCoef: 0.9, singleFiveCoef: 1.15,
    sunTwoPeopleCoef: 0.85, sunSandPerGate: 2, singleSandPerGate: 2,
    sandHandQty: 2, sandHandTime: 6, sandCartQty: 6, sandCartTime: 5,
    wTime: 100, wIdle: 80, wFatigue: 18, wHardStreak: 25, wTripBalance: 45,
  },
};

function bbNormalizeConfig(input = {}) {
  const mergedRules = plannerClone(BB_DEFAULT_TRANSPORT_RULES);
  for (const [key, rule] of Object.entries(input.rules || {})) {
    if (mergedRules[key]) mergedRules[key] = { ...mergedRules[key], ...rule };
  }
  return {
    ...plannerClone(BB_DEFAULT_TRANSPORT_CONFIG),
    ...input,
    counts: { ...BB_DEFAULT_TRANSPORT_CONFIG.counts, ...(input.counts || {}) },
    params: { ...BB_DEFAULT_TRANSPORT_CONFIG.params, ...(input.params || {}) },
    rules: mergedRules,
    peopleStart: Math.max(1, Math.min(7, Math.floor(plannerNumber(input.peopleStart, BB_DEFAULT_TRANSPORT_CONFIG.peopleStart)))),
    carts: Math.max(0, Math.floor(plannerNumber(input.carts, BB_DEFAULT_TRANSPORT_CONFIG.carts))),
    maxTrips: Math.max(1, Math.floor(plannerNumber(input.maxTrips, BB_DEFAULT_TRANSPORT_CONFIG.maxTrips))),
    nodeLimit: Math.max(2000, Math.floor(plannerNumber(input.nodeLimit, BB_DEFAULT_TRANSPORT_CONFIG.nodeLimit))),
  };
}

function bbCombos(n, k) {
  const res = [];
  function rec(start, picked) {
    if (picked.length === k) { res.push(picked.slice()); return; }
    for (let i = start; i < n; i += 1) { picked.push(i); rec(i + 1, picked); picked.pop(); }
  }
  rec(0, []);
  return res;
}

function bbPartFixed(total, sizes) {
  const out = [];
  const uniq = [...new Set(sizes.filter((x) => x > 0))].sort((a, b) => b - a);
  function rec(rem, arr, last) {
    if (rem <= 0) { out.push(arr.slice()); return; }
    for (const size of uniq) {
      const qty = Math.min(size, rem);
      if (qty > last) continue;
      arr.push(qty);
      rec(rem - qty, arr, qty);
      arr.pop();
    }
  }
  rec(Math.max(0, Math.floor(total)), [], 999);
  return out.length ? out : [[]];
}

function bbBoundedDistributions(caps, total) {
  const out = [];
  const n = caps.length;
  function rec(index, rem, picked) {
    if (index === n) { if (rem === 0) out.push(picked.slice()); return; }
    const restMax = caps.slice(index + 1).reduce((sum, value) => sum + value, 0);
    const lo = Math.max(0, rem - restMax);
    const hi = Math.min(caps[index], rem);
    for (let value = lo; value <= hi; value += 1) { picked.push(value); rec(index + 1, rem - value, picked); picked.pop(); }
  }
  rec(0, Math.max(0, Math.floor(total)), []);
  return out.length ? out : [Array(n).fill(0)];
}

function bbMakeAlt(name, type, qty, people, cart, minutes, difficulty, tripCost = 1) {
  return { name, type, qty, people, cart, minutes, difficulty, tripCost };
}

function bbMakeJob(id, alts, deps = []) {
  return { id, alts, deps };
}

function bbBuildJobSets(cfg) {
  const r = cfg.rules;
  const p = cfg.params;
  const c = cfg.counts;
  const sets = [];
  const singleParts = bbPartFixed(plannerNumber(c.single), [Math.floor(p.singleQtyNormal), Math.floor(p.singleQtyMax)]);
  const sunParts = bbPartFixed(plannerNumber(c.sun), [Math.max(1, Math.floor(r.sun.qty || 2))]);

  function baseJobsFor(singlePart, sunPart) {
    const jobs = [];
    const sandNeeds = [];
    let index = 0;

    for (const qty of singlePart) {
      index += 1;
      const alts = [1, 2].map((people) => {
        const minutes = r.single.minutes * (people === 2 ? p.singleTwoPeopleCoef : 1) * (qty >= p.singleQtyMax ? p.singleFiveCoef : 1);
        return bbMakeAlt(`单门#${index}`, "single", qty, people, Math.max(0, Math.floor(r.single.cart)), minutes, r.single.difficulty);
      });
      const id = `single_${index}`;
      jobs.push(bbMakeJob(id, alts));
      if (cfg.wind) sandNeeds.push({ dep: id, target: `单门#${index}`, count: qty * Math.max(0, Math.floor(p.singleSandPerGate)) });
    }

    index = 0;
    for (const qty of sunPart) {
      index += 1;
      const alts = [1, 2].map((people) => (
        bbMakeAlt(`日字门#${index}`, "sun", qty, people, Math.max(0, Math.floor(r.sun.cart)), r.sun.minutes * (people === 2 ? p.sunTwoPeopleCoef : 1), r.sun.difficulty)
      ));
      const id = `sun_${index}`;
      jobs.push(bbMakeJob(id, alts));
      sandNeeds.push({ dep: id, target: `日字门#${index}`, count: qty * Math.max(0, Math.floor(p.sunSandPerGate)) });
    }

    for (const type of ["gravity", "doubleGravity", "triple"]) {
      const rule = r[type];
      if (!rule?.enabled) continue;
      for (let i = 1; i <= Math.max(0, Math.floor(plannerNumber(c[type]))); i += 1) {
        jobs.push(bbMakeJob(`${type}_${i}`, [bbMakeAlt(`${rule.name}#${i}`, type, 1, Math.max(1, Math.floor(rule.people)), Math.max(0, Math.floor(rule.cart)), rule.minutes, rule.difficulty)]));
      }
    }

    if (r.flag?.enabled !== false) {
      const flagCap = Math.max(1, Math.floor(r.flag.qty || 4));
      const flagParts = bbPartFixed(plannerNumber(c.flag), [flagCap]);
      let fi = 0;
      for (const qty of flagParts) {
        fi += 1;
        jobs.push(bbMakeJob(`flag_${fi}`, [bbMakeAlt(`${r.flag.name}#${fi}`, "flag", qty, Math.max(1, Math.floor(r.flag.people)), Math.max(0, Math.floor(r.flag.cart)), r.flag.minutes, r.flag.difficulty)]));
      }
    }

    const autoSand = sandNeeds.reduce((sum, item) => sum + item.count, 0);
    const manualSand = Number.isFinite(Number(c.sandbag)) && Number(c.sandbag) > 0 ? Number(c.sandbag) : null;
    const requested = cfg.sandbags === null || cfg.sandbags === undefined ? (manualSand ?? autoSand) : Math.max(0, Math.floor(cfg.sandbags));
    if (requested > autoSand) {
      sandNeeds.push({ dep: "", target: "沙包", count: requested - autoSand });
    }
    const totalSand = Math.min(requested, sandNeeds.reduce((sum, item) => sum + item.count, 0));
    const distList = sandNeeds.length ? bbBoundedDistributions(sandNeeds.map((item) => item.count), totalSand) : [[]];
    let sandSeq = 0;

    function appendSandPattern(baseJobs, needItem, need, mode) {
      const nextJobs = baseJobs.slice();
      let previous = needItem.dep;
      const trips = mode === "cart" ? splitPlannerTrips(need, p.sandCartQty) : splitPlannerTrips(need, p.sandHandQty);
      for (let ti = 0; ti < trips.length; ti += 1) {
        const qty = trips[ti];
        const label = mode === "cart" ? "小车" : "手提";
        const name = `沙包-${label}#${ti + 1} 对应 ${needItem.target}`;
        const id = `sand_${sandSeq += 1}_${ti}`;
        nextJobs.push(bbMakeJob(id, [bbMakeAlt(name, "sandbag", qty, 1, mode === "cart" ? 1 : 0, mode === "cart" ? p.sandCartTime : p.sandHandTime, 2.5, 1)], previous ? [previous] : []));
        previous = id;
      }
      return nextJobs;
    }

    for (const dist of distList) {
      let variants = [jobs.slice()];
      for (let di = 0; di < sandNeeds.length; di += 1) {
        const need = dist[di] || 0;
        if (need <= 0) continue;
        const next = [];
        for (const base of variants) {
          next.push(appendSandPattern(base, sandNeeds[di], need, "hand"));
          if (cfg.carts > 0) next.push(appendSandPattern(base, sandNeeds[di], need, "cart"));
        }
        variants = next;
      }
      for (const variant of variants) sets.push({ jobs: variant, autoSand, totalSand });
    }
  }

  for (const singlePart of singleParts) {
    for (const sunPart of sunParts) {
      baseJobsFor(singlePart, sunPart);
    }
  }
  return sets;
}

function bbTripImbalance(people) {
  const active = people.filter((person) => person.trips > 0);
  if (!active.length) return 0;
  const avg = active.reduce((sum, person) => sum + person.trips, 0) / active.length;
  return active.reduce((sum, person) => sum + (person.trips - avg) ** 2, 0);
}

function bbScore(plan, params) {
  return plan.makespan * params.wTime
    + plan.totalIdle * params.wIdle
    + plan.fatigue * params.wFatigue
    + plan.hardStreak * params.wHardStreak
    + (plan.tripImbalance || 0) * params.wTripBalance;
}

function bbClonePeople(people) {
  return people.map((person) => ({ ...person, jobs: person.jobs ? person.jobs.slice() : [] }));
}

function bbCloneCarts(carts) {
  return carts.map((cart) => ({ ...cart }));
}

function bbNormalizeKey(people, carts, mask, ends) {
  const p = people
    .map((item) => [item.t.toFixed(2), item.trips, item.fatigue.toFixed(1), item.lastDifficulty >= 4 ? 1 : 0])
    .sort((a, b) => Number(a[0]) - Number(b[0]) || a[1] - b[1] || Number(a[2]) - Number(b[2]))
    .map((item) => item.join(","))
    .join("|");
  const c = carts.map((item) => item.t.toFixed(2)).sort().join(",");
  return `${mask};${ends.map((value, index) => (mask & (1 << index) ? Number(value || 0).toFixed(2) : "")).join(",")};${p};${c}`;
}

function bbSummarizePlan(plan) {
  const counts = { single1: 0, single2: 0, single4: 0, single5: 0, sun1: 0, sun2: 0, flag: 0, sandHand: 0, sandCart: 0 };
  const seen = new Set();
  for (const person of plan.people || []) {
    for (const job of person.jobs || []) {
      const key = `${job.name}:${job.start}:${job.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (job.type === "single") {
        if (job.people === 1) counts.single1 += 1;
        else counts.single2 += 1;
        if (job.qty >= 5) counts.single5 += 1;
        else counts.single4 += 1;
      }
      if (job.type === "sun") {
        if (job.people === 1) counts.sun1 += 1;
        else counts.sun2 += 1;
      }
      if (job.type === "flag") {
        counts.flag += 1;
      }
      if (job.type === "sandbag") {
        if (String(job.name).includes("手提")) counts.sandHand += 1;
        if (String(job.name).includes("小车")) counts.sandCart += 1;
      }
    }
  }
  return `混用规则：单门 ${counts.single4} 趟≤4个、${counts.single5} 趟5个；单门 ${counts.single1} 趟1人、${counts.single2} 趟2人；日字门 ${counts.sun1} 趟1人、${counts.sun2} 趟2人；刀旗 ${counts.flag} 趟；沙包 手提${counts.sandHand}趟、小车${counts.sandCart}趟`;
}

function bbOptimizeJobSet(jobs, peopleCount, cfg, budget, global) {
  const people = Array.from({ length: peopleCount }, (_, index) => ({ id: index + 1, t: 0, trips: 0, fatigue: 0, lastDifficulty: 0, jobs: [] }));
  const carts = Array.from({ length: cfg.carts }, (_, index) => ({ id: index + 1, t: 0 }));
  const allMask = (1 << jobs.length) - 1;
  const depIdxs = jobs.map((job) => job.deps.map((dep) => jobs.findIndex((item) => item.id === dep)).filter((index) => index >= 0));
  const depMasks = depIdxs.map((items) => items.reduce((mask, index) => mask | (1 << index), 0));
  const memo = new Map();
  const combosCache = {};
  let nodes = 0;
  let best = null;
  let proven = true;
  let upperScore = global.score || Infinity;

  function pack(nextPeople, totalIdle, hardStreak) {
    const makespan = Math.max(0, ...nextPeople.map((person) => person.t));
    const fatigue = nextPeople.reduce((sum, person) => sum + person.fatigue, 0);
    const plan = {
      people: bbClonePeople(nextPeople),
      makespan,
      totalIdle,
      hardStreak,
      fatigue,
      tripImbalance: bbTripImbalance(nextPeople),
      peopleCount,
      usedCount: nextPeople.filter((person) => person.jobs?.length).length,
      nodes: global.nodes,
    };
    plan.score = bbScore(plan, cfg.params);
    return plan;
  }

  function getCombos(n, k) {
    const key = `${n},${k}`;
    if (!combosCache[key]) combosCache[key] = bbCombos(n, k);
    return combosCache[key];
  }

  function genMoves(nextPeople, nextCarts, ends, mask) {
    const moves = [];
    for (let jobIndex = 0; jobIndex < jobs.length; jobIndex += 1) {
      if (mask & (1 << jobIndex)) continue;
      if ((depMasks[jobIndex] & mask) !== depMasks[jobIndex]) continue;
      const depReady = depIdxs[jobIndex].reduce((max, depIndex) => Math.max(max, ends[depIndex] || 0), 0);
      for (const alt of jobs[jobIndex].alts) {
        if (alt.cart > cfg.carts) continue;
        const available = nextPeople.map((person, index) => ({ person, index })).filter(({ person }) => person.trips + alt.tripCost <= cfg.maxTrips);
        for (const combo of getCombos(available.length, alt.people)) {
          const ids = combo.map((item) => available[item].index);
          let cart = null;
          let cartReady = 0;
          if (alt.cart > 0) {
            if (!nextCarts.length) continue;
            cart = nextCarts.slice().sort((a, b) => a.t - b.t)[0];
            cartReady = cart.t;
          }
          const peopleReady = ids.length ? Math.max(...ids.map((id) => nextPeople[id].t)) : 0;
          const start = Math.max(depReady, peopleReady, cartReady);
          const end = start + alt.minutes;
          const idle = ids.reduce((sum, id) => sum + Math.max(0, start - nextPeople[id].t), 0);
          const streak = ids.reduce((sum, id) => sum + (nextPeople[id].lastDifficulty >= 4 && alt.difficulty >= 4 ? 1 : 0), 0);
          moves.push({ jobIndex, alt, ids, cartId: cart?.id || null, start, end, idle, streak, local: end * 10 + idle * 4 + streak * 15 + alt.difficulty });
        }
      }
    }
    return moves;
  }

  function applyMove(nextPeople, nextCarts, ends, move) {
    const groupKey = move.ids.map((id) => nextPeople[id].id).sort((a, b) => a - b).join("+");
    const job = {
      ...move.alt,
      start: move.start,
      end: move.end,
      peopleIds: move.ids.map((id) => nextPeople[id].id),
      groupKey,
      cartId: move.cartId,
    };
    for (const id of move.ids) {
      nextPeople[id].t = move.end;
      nextPeople[id].trips += move.alt.tripCost;
      nextPeople[id].fatigue += move.alt.difficulty * move.alt.tripCost;
      nextPeople[id].lastDifficulty = move.alt.difficulty;
      nextPeople[id].jobs.push(job);
    }
    ends[move.jobIndex] = move.end;
    if (move.cartId) {
      const cart = nextCarts.find((item) => item.id === move.cartId);
      if (cart) cart.t = move.end;
    }
  }

  function lowerBound(nextPeople, totalIdle, hardStreak) {
    const makespan = Math.max(0, ...nextPeople.map((person) => person.t));
    const fatigue = nextPeople.reduce((sum, person) => sum + person.fatigue, 0);
    return makespan * cfg.params.wTime + totalIdle * cfg.params.wIdle + fatigue * cfg.params.wFatigue + hardStreak * cfg.params.wHardStreak;
  }

  function greedy() {
    const nextPeople = bbClonePeople(people);
    const nextCarts = bbCloneCarts(carts);
    const ends = Array(jobs.length).fill(0);
    let mask = 0;
    let totalIdle = 0;
    let hard = 0;
    let guard = 0;
    while (mask !== allMask && guard < jobs.length * 5) {
      guard += 1;
      const moves = genMoves(nextPeople, nextCarts, ends, mask).sort((a, b) => a.end - b.end || a.alt.difficulty - b.alt.difficulty);
      if (!moves.length) break;
      applyMove(nextPeople, nextCarts, ends, moves[0]);
      totalIdle += moves[0].idle;
      hard += moves[0].streak;
      mask |= 1 << moves[0].jobIndex;
    }
    return mask === allMask ? pack(nextPeople, totalIdle, hard) : null;
  }

  function branch(nextPeople, nextCarts, ends, mask, totalIdle, hardStreak) {
    nodes += 1;
    global.nodes += 1;
    if (nodes > budget || global.nodes > cfg.nodeLimit) {
      proven = false;
      return;
    }
    if (lowerBound(nextPeople, totalIdle, hardStreak) >= upperScore) return;
    if (mask === allMask) {
      const plan = pack(nextPeople, totalIdle, hardStreak);
      if (plan.score < upperScore) {
        best = plan;
        upperScore = plan.score;
        global.score = plan.score;
        global.plan = plan;
      }
      return;
    }
    const key = bbNormalizeKey(nextPeople, nextCarts, mask, ends);
    const partial = totalIdle * cfg.params.wIdle + hardStreak * cfg.params.wHardStreak;
    if (memo.has(key) && memo.get(key) <= partial) return;
    memo.set(key, partial);
    const moves = genMoves(nextPeople, nextCarts, ends, mask).sort((a, b) => a.local - b.local);
    for (const move of moves) {
      const branchedPeople = bbClonePeople(nextPeople);
      const branchedCarts = bbCloneCarts(nextCarts);
      const branchedEnds = ends.slice();
      applyMove(branchedPeople, branchedCarts, branchedEnds, move);
      branch(branchedPeople, branchedCarts, branchedEnds, mask | (1 << move.jobIndex), totalIdle + move.idle, hardStreak + move.streak);
      if (!proven) return;
    }
  }

  const greedyPlan = greedy();
  if (greedyPlan && greedyPlan.score < upperScore) {
    best = greedyPlan;
    upperScore = greedyPlan.score;
    global.score = greedyPlan.score;
    global.plan = greedyPlan;
  }
  branch(people, carts, Array(jobs.length).fill(0), 0, 0, 0);
  if (best) best.nodes = global.nodes;
  return { best, proven, nodes };
}

function bbCalculateTransportPlans(input = {}) {
  const cfg = bbNormalizeConfig(input);
  const startedAt = Date.now();
  const sets = bbBuildJobSets(cfg).filter((set) => set.jobs.length < 30);
  const peopleOrder = [];
  const start = cfg.peopleStart;
  for (let delta = 0; delta <= 6; delta += 1) {
    const lower = start - delta;
    const upper = start + delta;
    if (lower >= 1 && lower <= 7 && !peopleOrder.includes(lower)) peopleOrder.push(lower);
    if (upper >= 1 && upper <= 7 && !peopleOrder.includes(upper)) peopleOrder.push(upper);
  }
  for (let people = 1; people <= 7; people += 1) {
    if (!peopleOrder.includes(people)) peopleOrder.push(people);
  }

  const all = [];
  const global = { nodes: 0, score: Infinity, plan: null };
  const budgetEach = Math.max(2000, Math.floor(cfg.nodeLimit / Math.max(1, sets.length * peopleOrder.length)));
  let allProven = true;

  for (const set of sets) {
    for (const peopleCount of peopleOrder) {
      if (global.nodes >= cfg.nodeLimit) {
        allProven = false;
        break;
      }
      const result = bbOptimizeJobSet(set.jobs, peopleCount, cfg, Math.min(budgetEach, cfg.nodeLimit - global.nodes), global);
      if (result.best) {
        result.best.peopleCount = peopleCount;
        result.best.ruleSummary = bbSummarizePlan(result.best);
        result.best.proven = result.proven;
        all.push(result.best);
      }
      if (!result.proven) allProven = false;
    }
    if (global.nodes >= cfg.nodeLimit) break;
  }

  all.sort((a, b) => a.score - b.score || a.makespan - b.makespan || a.peopleCount - b.peopleCount);
  const picked = [];
  const seen = new Set();
  for (const plan of all) {
    const key = `${plan.peopleCount}-${plan.makespan.toFixed(1)}-${plan.ruleSummary}`;
    if (!seen.has(key)) {
      seen.add(key);
      picked.push(plan);
    }
    if (picked.length >= 10) break;
  }
  return {
    plans: picked,
    meta: {
      proven: allProven && global.nodes < cfg.nodeLimit,
      nodes: global.nodes,
      elapsed: Date.now() - startedAt,
      setCount: sets.length,
    },
    config: cfg,
  };
}

const dataDir = path.resolve("data");
const bracketStateFile = path.join(dataDir, "bracket-state.json");
const pilotsJsonFile = path.join(dataDir, "pilots.json");
const eventsJsonFile = path.join(dataDir, "events.json");
const dbFile = path.join(dataDir, "training.db");
const trainingCsvFile = path.join(dataDir, "training-joystick-samples.csv");
let bracketStateCache = null;
let bracketStateCacheLoaded = false;

app.use(express.json({ limit: "10mb" }));

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
}

const defaultChannelConfig = {
  ch5: [{ name: "Arm", type: "arm", min: 1500, max: 1998 }],
  ch6: [
    { name: "Angle", type: "mode", min: 1500, max: 1800 },
    { name: "Air", type: "mode", min: 1800, max: 1998 },
  ],
  ch7: [{ name: "Turtle", type: "turtle", min: 1500, max: 1998 }],
  ch8: [],
};

const defaultPilots = [
  { id: "pilot-1", name: "选手1", rates: "BF: 600/600/500", note: "新手，注意控高", channelConfig: defaultChannelConfig },
  { id: "pilot-2", name: "选手2", rates: "BF: 550/550/450", note: "", channelConfig: defaultChannelConfig },
];

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function readJsonIfExists(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return safeJsonParse(fs.readFileSync(filePath, "utf-8"), fallback);
}

const liveRooms = new Map();
const serverLiveState = {
  latestSamplesByReceiver: {},
  receiverState: {
    connected: false,
    receiverCount: 0,
    maxReceiverId: 0,
    packetCount: 0,
    lastDataAt: null,
    lastReceiverId: null,
    error: "",
  },
};
const runtimeEvents = new Map();
const SAMPLE_WRITE_INTERVAL_MS = 200;
const STATS_REFRESH_INTERVAL_MS = 1000;
const RECEIVER_DB_WRITE_INTERVAL_MS = 1000;
const LIVE_BATCH_BROADCAST_INTERVAL_MS = 33;
const MAX_SAMPLE_GAP_MS = 1000;
const RECENT_SAMPLE_WINDOW_MS = 5000;
const LIVE_STATE_BROADCAST_INTERVAL_MS = 1000;
const RECEIVER_OFFLINE_AFTER_MS = 2500;
const LIVE_RELAY_MAX_BUFFER_BYTES = 512 * 1024;
const receiverDbWriteTimes = new Map();
const pendingLiveBatches = new Map();
const pendingSerialPackets = new Map();
const pendingTrainingCsvPackets = [];
const pendingTrainingCsvLines = [];
const trainingCsvStatus = {
  queuedRows: 0,
  queuedBytes: 0,
  writtenRows: 0,
  bytesWritten: 0,
  fileSizeBytes: 0,
  lastFlushMs: 0,
  lastFlushAt: null,
  lastError: "",
  flushInFlight: false,
};
const csvRuntimeEvents = new Map();
let lastReceiverOfflineMarkAt = 0;

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
  const throttleValues = recentSamples.map((item) => item.channels?.ch3).filter((value) => Number.isFinite(value));
  const throttleSpread = throttleValues.length ? Math.max(...throttleValues) - Math.min(...throttleValues) : 0;
  const turtle = armed && turtleSwitch;
  const flying = armed && throttleSpread > 80;
  return { armed, mode: getPilotMode(pilot, sample), turtleSwitch, turtle, flying, idle: !turtle && !flying, throttleSpread };
}

function parseSerialPacket(packet, receivedAt = Date.now()) {
  const frameTime = Number(packet?.t) || null;
  const items = packet?.type === "rx_batch" && Array.isArray(packet.items) ? packet.items : [packet];
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
  const time = Number(item?.t);
  if (Number.isFinite(lq)) compact.lq = lq;
  if (Number.isFinite(rssi)) compact.rssi = rssi;
  if (Number.isFinite(time)) compact.t = time;
  return compact;
}

function compactLiveBatch(packet) {
  if (!packet || typeof packet !== "object") return packet;
  if (packet.type === "rx_batch" && Array.isArray(packet.items)) {
    const compact = {
      type: "rx_batch",
      v: Number(packet.v) || 1,
      items: packet.items.map(compactLiveItem).filter((item) => Number.isFinite(item.rx) && item.ch.length >= 8),
    };
    const time = Number(packet.t);
    if (Number.isFinite(time)) compact.t = time;
    return compact;
  }
  return compactLiveItem(packet);
}

function getLiveRoom(roomId = "default") {
  const safeRoomId = String(roomId || "default").slice(0, 64);
  if (!liveRooms.has(safeRoomId)) {
    liveRooms.set(safeRoomId, {
      publishers: new Set(),
      subscribers: new Set(),
      lastBatch: null,
      updatedAt: null,
      currentState: null,
      stateUpdatedAt: null,
    });
  }
  return liveRooms.get(safeRoomId);
}

function writeWebSocketFrame(socket, opcode, payload = Buffer.alloc(0)) {
  if (socket.destroyed) return;
  const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  let header;
  if (payloadBuffer.length < 126) {
    header = Buffer.from([0x80 | opcode, payloadBuffer.length]);
  } else if (payloadBuffer.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payloadBuffer.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payloadBuffer.length), 2);
  }
  socket.write(Buffer.concat([header, payloadBuffer]));
}

function sendLiveSocketJson(client, message) {
  writeWebSocketFrame(client.socket, 0x1, Buffer.from(JSON.stringify(message), "utf-8"));
}

function readWebSocketFrames(client, chunk) {
  client.buffer = Buffer.concat([client.buffer, chunk]);
  const frames = [];

  while (client.buffer.length >= 2) {
    let offset = 2;
    const first = client.buffer[0];
    const second = client.buffer[1];
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;

    if (length === 126) {
      if (client.buffer.length < offset + 2) break;
      length = client.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (client.buffer.length < offset + 8) break;
      length = Number(client.buffer.readBigUInt64BE(offset));
      offset += 8;
    }

    const maskLength = masked ? 4 : 0;
    if (client.buffer.length < offset + maskLength + length) break;

    const mask = masked ? client.buffer.subarray(offset, offset + 4) : null;
    offset += maskLength;
    const payload = Buffer.from(client.buffer.subarray(offset, offset + length));
    client.buffer = client.buffer.subarray(offset + length);

    if (mask) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }

    frames.push({ opcode, payload });
  }

  return frames;
}

function removeLiveClient(client) {
  if (client.role === "publisher") {
    serverLiveState.inputInterruptedAt = Date.now();
    for (const runtime of runtimeEvents.values()) {
      runtime.inputInterruptedAt = serverLiveState.inputInterruptedAt;
    }
  }
  for (const room of liveRooms.values()) {
    room.publishers.delete(client);
    room.subscribers.delete(client);
  }
}

function joinLiveRoom(client, roomId, role) {
  removeLiveClient(client);
  const room = getLiveRoom(roomId);
  client.roomId = String(roomId || "default").slice(0, 64);
  client.role = role;
  if (role === "publisher") room.publishers.add(client);
  if (role === "subscriber") {
    room.subscribers.add(client);
    if (room.currentState) {
      sendLiveSocketJson(client, {
        type: "live_state",
        room: client.roomId,
        state: room.currentState,
        serverTime: room.stateUpdatedAt || Date.now(),
      });
    }
    if (room.lastBatch) {
      sendLiveSocketJson(client, {
        type: "live_batch",
        room: client.roomId,
        batch: room.lastBatch,
        serverTime: room.updatedAt,
      });
    }
  }
  sendLiveSocketJson(client, { type: "live_ack", role, room: client.roomId, serverTime: Date.now() });
}

function broadcastLiveState(roomId, state) {
  const room = getLiveRoom(roomId);
  room.currentState = state || null;
  room.stateUpdatedAt = Date.now();
  if (!room.currentState) return;

  const outgoing = {
    type: "live_state",
    room: String(roomId || "default").slice(0, 64),
    state: room.currentState,
    serverTime: room.stateUpdatedAt,
  };

  for (const subscriber of room.subscribers) {
    if (subscriber.socket.destroyed || subscriber.socket.writableLength > 512 * 1024) continue;
    sendLiveSocketJson(subscriber, outgoing);
  }
}

function broadcastLiveBatch(roomId, batch, serverTime) {
  const room = getLiveRoom(roomId);
  room.lastBatch = batch;
  room.updatedAt = serverTime;
  const outgoing = {
    type: "live_batch",
    room: String(roomId || "default").slice(0, 64),
    batch,
    serverTime,
  };

  for (const subscriber of room.subscribers) {
    if (subscriber.socket.destroyed || subscriber.socket.writableLength > LIVE_RELAY_MAX_BUFFER_BYTES) continue;
    sendLiveSocketJson(subscriber, outgoing);
  }
}

function queueLiveBatchForBroadcast(roomId, batch, serverTime) {
  pendingLiveBatches.set(String(roomId || "default").slice(0, 64), {
    batch: compactLiveBatch(batch),
    serverTime,
  });
}

function processQueuedLiveBatches() {
  const entries = [...pendingLiveBatches.entries()];
  pendingLiveBatches.clear();
  for (const [roomId, queued] of entries) {
    broadcastLiveBatch(roomId, queued.batch, queued.serverTime);
  }
}

function queueSerialPacketForPersistence(roomId, packet, receivedAt) {
  pendingSerialPackets.set(String(roomId || "default").slice(0, 64), { packet, receivedAt });
}

function queueSerialPacketForCsv(roomId, packet, receivedAt) {
  pendingTrainingCsvPackets.push({
    roomId: String(roomId || "default").slice(0, 64),
    packet,
    receivedAt,
  });
}

function handleLiveSocketMessage(client, message) {
  if (message.type === "publish_live") {
    joinLiveRoom(client, message.room || "default", "publisher");
    return;
  }
  if (message.type === "subscribe_live") {
    joinLiveRoom(client, message.room || "default", "subscriber");
    return;
  }
  if (message.type === "live_state" && client.role === "publisher") {
    broadcastLiveState(client.roomId || message.room || "default", message.state || null);
    return;
  }
  if (!["live_batch", "serial_packet"].includes(message.type) || client.role !== "publisher") return;

  const roomId = client.roomId || message.room || "default";
  const batch = message.batch || message.packet || null;
  if (!batch) return;

  const receivedAt = Date.now();
  queueLiveBatchForBroadcast(roomId, batch, receivedAt);
  queueSerialPacketForCsv(roomId, batch, receivedAt);
  queueSerialPacketForPersistence(roomId, batch, receivedAt);
}

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname !== "/live-ws") {
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    "",
  ].join("\r\n"));

  const client = {
    socket,
    buffer: Buffer.alloc(0),
    roomId: null,
    role: null,
  };

  socket.on("data", (chunk) => {
    for (const frame of readWebSocketFrames(client, chunk)) {
      if (frame.opcode === 0x8) {
        socket.end();
        return;
      }
      if (frame.opcode === 0x9) {
        writeWebSocketFrame(socket, 0xA, frame.payload);
        continue;
      }
      if (frame.opcode !== 0x1) continue;
      try {
        handleLiveSocketMessage(client, JSON.parse(frame.payload.toString("utf-8")));
      } catch {
        sendLiveSocketJson(client, { type: "live_error", error: "invalid json" });
      }
    }
  });
  socket.on("close", () => removeLiveClient(client));
  socket.on("error", () => removeLiveClient(client));
});

const db = new DatabaseSync(dbFile);

function runTransaction(work) {
  db.exec("BEGIN");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS pilots (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    rates TEXT NOT NULL DEFAULT '',
    rate_profile_json TEXT,
    note TEXT NOT NULL DEFAULT '',
    channel_config_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS training_events (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    started_at INTEGER,
    ended_at INTEGER,
    active INTEGER NOT NULL DEFAULT 0,
    participants_json TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS training_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL,
    pilot_id TEXT NOT NULL,
    receiver_id INTEGER NOT NULL,
    time INTEGER NOT NULL,
    ch1 INTEGER, ch2 INTEGER, ch3 INTEGER, ch4 INTEGER,
    ch5 INTEGER, ch6 INTEGER, ch7 INTEGER, ch8 INTEGER,
    armed INTEGER NOT NULL DEFAULT 0,
    flying INTEGER NOT NULL DEFAULT 0,
    turtle INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_training_samples_event_pilot_time
    ON training_samples(event_id, pilot_id, time);
  CREATE TABLE IF NOT EXISTS training_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL,
    pilot_id TEXT NOT NULL,
    type TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_training_segments_event_pilot
    ON training_segments(event_id, pilot_id);
  CREATE TABLE IF NOT EXISTS training_event_stats (
    event_id TEXT NOT NULL,
    pilot_id TEXT NOT NULL,
    total_flight_ms INTEGER NOT NULL DEFAULT 0,
    utilization REAL NOT NULL DEFAULT 0,
    idle_ms INTEGER,
    total_turtle_ms INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (event_id, pilot_id)
  );
  CREATE TABLE IF NOT EXISTS training_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS receivers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    online INTEGER NOT NULL DEFAULT 1,
    binding INTEGER NOT NULL DEFAULT 0,
    bind_requested_at INTEGER,
    last_seen_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tracks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    trackdraw_project_id TEXT NOT NULL DEFAULT '',
    trackdraw_embed_url TEXT NOT NULL DEFAULT '',
    track_json TEXT,
    overlay_json TEXT,
    field_width REAL,
    field_height REAL,
    route_length REAL,
    trackdraw_updated_at TEXT,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    sync_error TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS track_equipment (
    track_id TEXT NOT NULL,
    equipment_type TEXT NOT NULL,
    auto_quantity INTEGER NOT NULL DEFAULT 0,
    corrected_quantity INTEGER,
    final_quantity INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (track_id, equipment_type)
  );
  CREATE TABLE IF NOT EXISTS track_unknown_objects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id TEXT NOT NULL,
    raw_json TEXT NOT NULL,
    guessed_name TEXT NOT NULL DEFAULT '',
    assigned_equipment_type TEXT NOT NULL DEFAULT '',
    ignored INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS transport_rules (
    equipment_type TEXT PRIMARY KEY,
    people_required INTEGER NOT NULL DEFAULT 1,
    max_per_trip INTEGER NOT NULL DEFAULT 1,
    trip_time_minutes REAL NOT NULL DEFAULT 1,
    cart_required INTEGER NOT NULL DEFAULT 0,
    difficulty REAL NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    note TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS transport_plans (
    id TEXT PRIMARY KEY,
    track_id TEXT NOT NULL,
    plan_type TEXT NOT NULL DEFAULT 'search',
    title TEXT NOT NULL,
    people_count INTEGER NOT NULL DEFAULT 0,
    used_people_count INTEGER NOT NULL DEFAULT 0,
    estimated_minutes REAL NOT NULL DEFAULT 0,
    idle_minutes REAL NOT NULL DEFAULT 0,
    fatigue_score REAL NOT NULL DEFAULT 0,
    trip_imbalance REAL NOT NULL DEFAULT 0,
    plan_json TEXT NOT NULL,
    selected INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

const pilotColumns = db.prepare("PRAGMA table_info(pilots)").all().map((column) => column.name);
if (!pilotColumns.includes("rate_profile_json")) {
  db.exec("ALTER TABLE pilots ADD COLUMN rate_profile_json TEXT");
}

const upsertTransportRule = db.prepare(`
  INSERT INTO transport_rules
    (equipment_type, people_required, max_per_trip, trip_time_minutes, cart_required, difficulty, enabled, note)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(equipment_type) DO UPDATE SET
    people_required = excluded.people_required,
    max_per_trip = excluded.max_per_trip,
    trip_time_minutes = excluded.trip_time_minutes,
    cart_required = excluded.cart_required,
    difficulty = excluded.difficulty,
    enabled = excluded.enabled,
    note = excluded.note
`);

function ensureDefaultTransportRules() {
  const existingRows = db.prepare("SELECT equipment_type FROM transport_rules").all();
  const existing = new Set(existingRows.map((row) => row.equipment_type));
  for (const [key, rule] of Object.entries(DEFAULT_TRANSPORT_RULES)) {
    if (existing.has(key)) continue;
    upsertTransportRule.run(
      key,
      Math.max(1, Math.floor(Number(rule.people) || 1)),
      Math.max(1, Math.floor(Number(rule.qty) || 1)),
      Number(rule.minutes) || 1,
      Math.max(0, Math.floor(Number(rule.cart) || 0)),
      Number(rule.difficulty) || 1,
      rule.enabled === false ? 0 : 1,
      rule.note || "",
    );
  }
}

ensureDefaultTransportRules();

const getPilotCount = db.prepare("SELECT COUNT(*) AS count FROM pilots");
const upsertPilot = db.prepare(`
  INSERT INTO pilots (id, name, rates, rate_profile_json, note, channel_config_json, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    rates = excluded.rates,
    rate_profile_json = excluded.rate_profile_json,
    note = excluded.note,
    channel_config_json = excluded.channel_config_json,
    updated_at = excluded.updated_at
`);

function migrateJsonToSqlite() {
  if (getPilotCount.get().count === 0) {
    const pilots = readJsonIfExists(pilotsJsonFile, defaultPilots);
    const now = Date.now();
    for (const pilot of Array.isArray(pilots) ? pilots : defaultPilots) {
      upsertPilot.run(
        pilot.id,
        pilot.name || pilot.id,
        pilot.rates || "",
        pilot.rateProfile ? JSON.stringify(pilot.rateProfile) : null,
        pilot.note || "",
        JSON.stringify(pilot.channelConfig || defaultChannelConfig),
        now,
      );
    }
  }

  const eventCount = db.prepare("SELECT COUNT(*) AS count FROM training_events").get().count;
  if (eventCount === 0) {
    const events = readJsonIfExists(eventsJsonFile, []);
    const upsertEvent = db.prepare(`
      INSERT INTO training_events (id, name, started_at, ended_at, active, participants_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        active = excluded.active,
        participants_json = excluded.participants_json,
        updated_at = excluded.updated_at
    `);
    for (const event of Array.isArray(events) ? events : []) {
      const now = Date.now();
      upsertEvent.run(
        event.id,
        event.name || event.id,
        event.startedAt || null,
        event.endedAt || null,
        event.active ? 1 : 0,
        JSON.stringify(event.participants || []),
        event.createdAt || event.startedAt || now,
        now,
      );
    }
  }

  const receiverSetting = db.prepare("SELECT value_json FROM training_settings WHERE key = ?").get("receiverCount");
  if (!receiverSetting) {
    db.prepare("INSERT INTO training_settings (key, value_json) VALUES (?, ?)").run("receiverCount", JSON.stringify(8));
  }
}

migrateJsonToSqlite();

function pilotFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    rates: row.rates,
    rateProfile: safeJsonParse(row.rate_profile_json, null),
    note: row.note,
    channelConfig: safeJsonParse(row.channel_config_json, defaultChannelConfig),
  };
}

function eventFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    active: Boolean(row.active),
    participants: safeJsonParse(row.participants_json, []),
    createdAt: row.created_at,
  };
}

function sampleChannelValue(sample, channelKey) {
  const value = Number(sample?.channels?.[channelKey]);
  return Number.isFinite(value) ? value : null;
}

function optionalTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function getParticipantForPilot(event, pilotId) {
  return (event?.participants || []).find((participant) => participant.pilotId === pilotId) || null;
}

function getParticipantTrainingWindow(event, participantOrPilotId, now = Date.now()) {
  const participant = typeof participantOrPilotId === "object"
    ? participantOrPilotId
    : getParticipantForPilot(event, participantOrPilotId);
  const eventStart = optionalTimestamp(event?.startedAt) || optionalTimestamp(event?.createdAt) || now;
  const eventEnd = optionalTimestamp(event?.endedAt) || now;
  const requestedStart = optionalTimestamp(participant?.trainingStartAt);
  const requestedEnd = optionalTimestamp(participant?.trainingEndAt);
  const start = Math.max(eventStart, requestedStart || eventStart);
  const end = Math.max(start, Math.min(eventEnd, requestedEnd || eventEnd));
  return { start, end };
}

function computeTimelineStats(samples, eventStart, eventEnd) {
  const sorted = [...samples].sort((a, b) => a.time - b.time);
  const firstTime = sorted[0]?.time || Date.now();
  const safeStart = Number(eventStart) || firstTime;
  const safeEnd = Math.max(safeStart, Number(eventEnd) || Date.now());
  let totalFlightMs = 0;
  let totalTurtleMs = 0;
  let lastFlightEnd = null;
  const segments = [];
  let current = null;

  function closeSegment(endTime) {
    if (!current) return;
    const endedAt = Math.max(current.startedAt, endTime);
    segments.push({
      type: current.type,
      startedAt: current.startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - current.startedAt),
    });
    current = null;
  }

  for (let index = 0; index < sorted.length; index += 1) {
    const sample = sorted[index];
    if (sample.time > safeEnd) break;
    if (sample.time < safeStart - MAX_SAMPLE_GAP_MS) continue;

    const intervalStart = Math.max(safeStart, sample.time);
    const nextTime = sorted[index + 1]?.time;
    if (!nextTime || nextTime - sample.time > MAX_SAMPLE_GAP_MS) continue;
    const intervalEnd = Math.min(safeEnd, nextTime, sample.time + MAX_SAMPLE_GAP_MS);
    if (intervalEnd <= intervalStart) continue;

    const type = sample.turtle ? "turtle" : sample.flying ? "flight" : "idle";
    const durationMs = intervalEnd - intervalStart;
    if (type === "flight") {
      totalFlightMs += durationMs;
      lastFlightEnd = intervalEnd;
    }
    if (type === "turtle") totalTurtleMs += durationMs;

    if (current && current.type !== type) closeSegment(intervalStart);
    if (!current && type) current = { type, startedAt: intervalStart, endedAt: intervalEnd };
    if (current && current.type === type) current.endedAt = intervalEnd;
  }

  if (current) closeSegment(current.endedAt);

  const duration = Math.max(1, safeEnd - safeStart);
  return {
    totalFlightMs,
    utilization: totalFlightMs / duration,
    idleMs: lastFlightEnd === null ? null : Math.max(0, safeEnd - lastFlightEnd),
    totalTurtleMs,
    segments,
  };
}

function computeEventOverview(event, eventId) {
  const rows = db.prepare(`
    SELECT pilot_id, time, armed, flying, turtle
    FROM training_samples
    WHERE event_id = ?
    ORDER BY pilot_id ASC, time ASC
  `).all(eventId);
  const samplesByPilot = new Map();
  for (const row of rows) {
    const list = samplesByPilot.get(row.pilot_id) || [];
    list.push({
      time: row.time,
      armed: Boolean(row.armed),
      flying: Boolean(row.flying),
      turtle: Boolean(row.turtle),
    });
    samplesByPilot.set(row.pilot_id, list);
  }

  const now = Date.now();
  const participantByPilot = new Map((event.participants || []).map((participant) => [participant.pilotId, participant]));
  const pilotIds = new Set([
    ...event.participants.map((participant) => participant.pilotId),
    ...samplesByPilot.keys(),
  ]);
  const stats = [];
  const segments = [];
  const sampleCounts = {};

  for (const pilotId of pilotIds) {
    const samples = samplesByPilot.get(pilotId) || [];
    sampleCounts[pilotId] = samples.length;
    const trainingWindow = getParticipantTrainingWindow(event, participantByPilot.get(pilotId) || pilotId, now);
    const computed = computeTimelineStats(samples, trainingWindow.start, trainingWindow.end);
    stats.push({
      event_id: eventId,
      pilot_id: pilotId,
      total_flight_ms: computed.totalFlightMs,
      utilization: computed.utilization,
      idle_ms: computed.idleMs,
      total_turtle_ms: computed.totalTurtleMs,
      updated_at: now,
    });
    for (const segment of computed.segments) {
      segments.push({
        event_id: eventId,
        pilot_id: pilotId,
        type: segment.type,
        started_at: segment.startedAt,
        ended_at: segment.endedAt,
        duration_ms: segment.durationMs,
      });
    }
  }

  return { stats, segments, sampleCounts };
}

function persistEventOverview(eventId, overview) {
  runTransaction(() => {
    for (const stat of overview.stats) {
      upsertStat.run(
        eventId,
        stat.pilot_id,
        Math.round(stat.total_flight_ms || 0),
        Number(stat.utilization || 0),
        stat.idle_ms ?? null,
        Math.round(stat.total_turtle_ms || 0),
        stat.updated_at,
      );
    }
    db.prepare("DELETE FROM training_segments WHERE event_id = ?").run(eventId);
    const insertSegment = db.prepare(`
      INSERT INTO training_segments (event_id, pilot_id, type, started_at, ended_at, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const segment of overview.segments) {
      insertSegment.run(
        eventId,
        segment.pilot_id,
        segment.type,
        segment.started_at,
        segment.ended_at,
        segment.duration_ms,
      );
    }
  });
}

function readCachedEventOverview(eventId) {
  const stats = db.prepare(`
    SELECT event_id, pilot_id, total_flight_ms, utilization, idle_ms, total_turtle_ms, updated_at
    FROM training_event_stats
    WHERE event_id = ?
    ORDER BY pilot_id
  `).all(eventId);
  const segments = db.prepare(`
    SELECT event_id, pilot_id, type, started_at, ended_at, duration_ms
    FROM training_segments
    WHERE event_id = ?
    ORDER BY started_at ASC
  `).all(eventId);
  return { stats, segments };
}

function bandStateFromSegmentType(type) {
  if (type === "flight") return "flying";
  if (type === "turtle") return "turtle";
  return "idle";
}

function bandsByPilotFromSegments(segments = []) {
  const bandsByPilot = {};
  for (const segment of segments) {
    const pilotId = segment.pilot_id;
    if (!bandsByPilot[pilotId]) bandsByPilot[pilotId] = [];
    bandsByPilot[pilotId].push({
      state: bandStateFromSegmentType(segment.type),
      start: segment.started_at,
      end: segment.ended_at,
    });
  }
  for (const bands of Object.values(bandsByPilot)) {
    bands.sort((left, right) => left.start - right.start);
  }
  return bandsByPilot;
}

function getReceiverCount() {
  const row = db.prepare("SELECT value_json FROM training_settings WHERE key = ?").get("receiverCount");
  const count = Number(safeJsonParse(row?.value_json, 8));
  return Math.max(1, Math.min(16, count || 8));
}

function setReceiverCount(count) {
  const safeCount = Math.max(1, Math.min(16, Number(count) || 8));
  db.prepare(`
    INSERT INTO training_settings (key, value_json)
    VALUES ('receiverCount', ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
  `).run(JSON.stringify(safeCount));
  return safeCount;
}

function getReceivers() {
  const count = getReceiverCount();
  const now = Date.now();
  const rows = db.prepare("SELECT * FROM receivers ORDER BY id").all();
  const byId = new Map(rows.map((row) => [row.id, row]));
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    name: byId.get(index + 1)?.name || `接收机 ${index + 1}`,
    online: byId.has(index + 1) ? Boolean(byId.get(index + 1).online) : index < Math.min(4, count),
    binding: Boolean(byId.get(index + 1)?.binding),
    bindRequestedAt: byId.get(index + 1)?.bind_requested_at || null,
    lastSeenAt: byId.get(index + 1)?.last_seen_at || now,
  }));
}

const TRACKDRAW_BASE_URL = process.env.TRACKDRAW_API_BASE_URL || "https://trackdraw.app";
const CURRENT_TRACK_SETTING_KEY = "currentTrackId";

function parseTrackdrawProjectId(input) {
  const value = String(input || "").trim();
  if (!value) return "";
  const iframeSrc = value.match(/src=["']([^"']+)["']/i)?.[1];
  if (iframeSrc) return parseTrackdrawProjectId(iframeSrc);
  try {
    const url = new URL(value);
    const embedIndex = url.pathname.split("/").findIndex((part) => part === "embed");
    if (embedIndex >= 0) return url.pathname.split("/")[embedIndex + 1] || "";
    const parts = url.pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] || "";
  } catch {
    const match = value.match(/(?:embed\/)?([A-Za-z0-9_-]{6,})(?:[/?#]|$)/);
    return match?.[1] || "";
  }
}

function normalizeTrackdrawEmbedUrl(input, projectId) {
  const value = String(input || "").trim();
  const iframeSrc = value.match(/src=["']([^"']+)["']/i)?.[1];
  if (iframeSrc) return iframeSrc;
  if (value) return value;
  return projectId ? `https://trackdraw.app/embed/${projectId}?view=3d` : "";
}

function parseJsonValue(text, fallback = null) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function settingJson(key, fallback = null) {
  const row = db.prepare("SELECT value_json FROM training_settings WHERE key = ?").get(key);
  return parseJsonValue(row?.value_json, fallback);
}

function setSettingJson(key, value) {
  db.prepare(`
    INSERT INTO training_settings (key, value_json)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
  `).run(key, JSON.stringify(value));
}

function equipmentRows(trackId) {
  return db.prepare("SELECT * FROM track_equipment WHERE track_id = ? ORDER BY equipment_type").all(trackId);
}

function unknownRows(trackId) {
  return db.prepare("SELECT * FROM track_unknown_objects WHERE track_id = ? ORDER BY id").all(trackId).map((row) => ({
    ...row,
    raw: parseJsonValue(row.raw_json, {}),
    ignored: Boolean(row.ignored),
  }));
}

function planRows(trackId) {
  return db.prepare("SELECT * FROM transport_plans WHERE track_id = ? ORDER BY selected DESC, estimated_minutes ASC, created_at ASC").all(trackId).map((row) => ({
    ...row,
    selected: Boolean(row.selected),
    plan: parseJsonValue(row.plan_json, null),
  }));
}

function trackFromRow(row, { includeJson = false, includeChildren = false } = {}) {
  if (!row) return null;
  const track = {
    id: row.id,
    name: row.name,
    location: row.location,
    note: row.note,
    trackdrawProjectId: row.trackdraw_project_id,
    trackdrawEmbedUrl: row.trackdraw_embed_url,
    fieldWidth: row.field_width,
    fieldHeight: row.field_height,
    routeLength: row.route_length,
    trackdrawUpdatedAt: row.trackdraw_updated_at,
    syncStatus: row.sync_status,
    syncError: row.sync_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  const overlayForSummary = parseJsonValue(row.overlay_json, null);
  const overlayDataForSummary = overlayForSummary?.data || overlayForSummary || {};
  const estimatedLapMs = overlayDataForSummary.duration_estimate?.estimated_lap_ms ?? null;
  if (estimatedLapMs !== null && estimatedLapMs !== undefined) track.estimatedLapMs = estimatedLapMs;
  if (includeJson) {
    track.trackJson = parseJsonValue(row.track_json, null);
    track.overlayJson = parseJsonValue(row.overlay_json, null);
  }
  if (includeChildren) {
    track.equipment = equipmentRows(row.id);
    track.unknownObjects = unknownRows(row.id);
    track.transportPlans = planRows(row.id);
    track.selectedPlan = track.transportPlans.find((plan) => plan.selected) || null;
  }
  return track;
}

function getTrackRow(trackId) {
  return db.prepare("SELECT * FROM tracks WHERE id = ?").get(trackId);
}

function getCurrentTrackId() {
  return settingJson(CURRENT_TRACK_SETTING_KEY, "");
}

function trackSummary(trackId) {
  const rows = equipmentRows(trackId);
  return rows
    .filter((row) => Number(row.final_quantity) > 0)
    .map((row) => `${equipmentLabel(row.equipment_type)} ${row.final_quantity}`)
    .join(" / ");
}

function equipmentLabel(type) {
  if (type === "flag") return "刀旗";
  return ({
    single: "单门",
    sun: "日字门",
    gravity: "重力门",
    doubleGravity: "双层重力门",
    triple: "三层门",
    sandbag: "沙包",
  })[type] || type;
}

function objectSearchText(object) {
  const parts = [];
  for (const key of ["kind", "name", "title", "type", "label"]) {
    if (object?.[key]) parts.push(String(object[key]));
  }
  return parts.join(" ").toLowerCase();
}

function recognizeEquipment(object) {
  const kind = String(object?.kind || "").toLowerCase();
  if (["startfinish", "start_finish", "polyline"].includes(kind)) return "__ignore";
  const rungs = Number(object?.rungs);
  if (kind === "divegate") return "gravity";
  if (kind === "gate") return "single";
  if (kind === "flag") return "flag";
  if (kind === "ladder" && rungs === 3) return "triple";
  if (kind === "ladder" && rungs === 2) return "sun";
  if (kind === "ladder") return "";
  const text = objectSearchText(object);
  if (!text) return "";
  if (/startfinish|start_finish|polyline/.test(text)) return "__ignore";
  if (/\bflag\b|刀旗/.test(text)) return "flag";
  if (/sandbag|沙包/.test(text)) return "sandbag";
  if (/triple|三层|目字/.test(text)) return "triple";
  if (/double|双层/.test(text)) return "doubleGravity";
  if (/sun|日字|ladder/.test(text)) return "sun";
  if (/gravity|重力/.test(text)) return "gravity";
  if (/gate|single|单门/.test(text)) return "single";
  return "";
}

function objectPosition(object) {
  const x = Number(object?.x ?? object?.position?.x ?? object?.center?.x ?? object?.route_position?.x);
  const y = Number(object?.y ?? object?.position?.y ?? object?.center?.y ?? object?.route_position?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function objectIdentity(item, index) {
  const raw = item.raw || {};
  return raw.id || raw.shape_id || raw.name || `${item.source}-${index}`;
}

function findLadderDoubleGravityGroups(objects) {
  const ladders = objects
    .map((item, index) => ({ item, index, key: objectIdentity(item, index), position: objectPosition(item.raw) }))
    .filter((entry) => String(entry.item.raw?.kind || "").toLowerCase() === "ladder" && entry.position);
  const consumed = new Set();
  let groups = 0;

  for (const anchor of ladders) {
    if (consumed.has(anchor.key)) continue;
    const nearby = ladders
      .filter((entry) => !consumed.has(entry.key))
      .filter((entry) => Math.abs(entry.position.x - anchor.position.x) <= 2.5 && Math.abs(entry.position.y - anchor.position.y) <= 2.5)
      .sort((left, right) => {
        const leftDistance = (left.position.x - anchor.position.x) ** 2 + (left.position.y - anchor.position.y) ** 2;
        const rightDistance = (right.position.x - anchor.position.x) ** 2 + (right.position.y - anchor.position.y) ** 2;
        return leftDistance - rightDistance;
      })
      .slice(0, 4);
    if (nearby.length < 4) continue;
    const xs = nearby.map((entry) => entry.position.x);
    const ys = nearby.map((entry) => entry.position.y);
    if (Math.max(...xs) - Math.min(...xs) > 2.5 || Math.max(...ys) - Math.min(...ys) > 2.5) continue;
    nearby.forEach((entry) => consumed.add(entry.key));
    groups += 1;
  }

  return { groups, consumed };
}

function collectTrackObjects(trackJson, overlayJson) {
  const seen = new Set();
  const objects = [];
  function addMany(items, source) {
    for (const item of Array.isArray(items) ? items : []) {
      const key = item?.id || item?.shape_id || item?.name || `${source}-${objects.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      objects.push({ source, raw: item });
    }
  }
  addMany(overlayJson?.data?.route_obstacles || overlayJson?.route_obstacles, "overlay.route_obstacles");
  addMany(trackJson?.data?.shapes || trackJson?.shapes, "track.shapes");
  return objects;
}

function persistAutoEquipment(trackId, trackJson, overlayJson) {
  const counts = { single: 0, sun: 0, gravity: 0, doubleGravity: 0, triple: 0, sandbag: 0, flag: 0 };
  const unknown = [];
  const objects = collectTrackObjects(trackJson, overlayJson);
  const ladderGroups = findLadderDoubleGravityGroups(objects);
  counts.doubleGravity += ladderGroups.groups;
  for (const [index, item] of objects.entries()) {
    if (ladderGroups.consumed.has(objectIdentity(item, index))) continue;
    const type = recognizeEquipment(item.raw);
    if (type === "__ignore") continue;
    if (type) counts[type] += 1;
    else unknown.push(item);
  }

  const existing = new Map(equipmentRows(trackId).map((row) => [row.equipment_type, row]));
  const upsertEquipment = db.prepare(`
    INSERT INTO track_equipment (track_id, equipment_type, auto_quantity, corrected_quantity, final_quantity, note)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(track_id, equipment_type) DO UPDATE SET
      auto_quantity = excluded.auto_quantity,
      final_quantity = COALESCE(track_equipment.corrected_quantity, excluded.auto_quantity),
      note = track_equipment.note
  `);
  for (const [type, autoQuantity] of Object.entries(counts)) {
    const current = existing.get(type);
    const corrected = current?.corrected_quantity ?? null;
    upsertEquipment.run(trackId, type, autoQuantity, corrected, corrected ?? autoQuantity, current?.note || "");
  }

  db.prepare("DELETE FROM track_unknown_objects WHERE track_id = ?").run(trackId);
  const insertUnknown = db.prepare(`
    INSERT INTO track_unknown_objects (track_id, raw_json, guessed_name, assigned_equipment_type, ignored)
    VALUES (?, ?, ?, '', 0)
  `);
  for (const item of unknown) {
    insertUnknown.run(trackId, JSON.stringify(item.raw), objectSearchText(item.raw).slice(0, 160));
  }
}

function unknownAssignedCounts(trackId) {
  const counts = {};
  const rows = db.prepare(`
    SELECT assigned_equipment_type AS type, COUNT(*) AS count
    FROM track_unknown_objects
    WHERE track_id = ? AND ignored = 0 AND assigned_equipment_type <> ''
    GROUP BY assigned_equipment_type
  `).all(trackId);
  for (const row of rows) counts[row.type] = row.count;
  return counts;
}

function refreshEquipmentFinalQuantities(trackId) {
  const assigned = unknownAssignedCounts(trackId);
  const rows = equipmentRows(trackId);
  const upsertEquipment = db.prepare(`
    INSERT INTO track_equipment (track_id, equipment_type, auto_quantity, corrected_quantity, final_quantity, note)
    VALUES (?, ?, 0, NULL, ?, '')
    ON CONFLICT(track_id, equipment_type) DO UPDATE SET
      final_quantity = COALESCE(track_equipment.corrected_quantity, track_equipment.auto_quantity + excluded.final_quantity)
  `);
  const knownTypes = new Set(rows.map((row) => row.equipment_type));
  for (const row of rows) {
    upsertEquipment.run(trackId, row.equipment_type, assigned[row.equipment_type] || 0);
  }
  for (const [type, count] of Object.entries(assigned)) {
    if (!knownTypes.has(type)) upsertEquipment.run(trackId, type, count);
  }
}

async function trackdrawFetch(pathname) {
  const apiKey = process.env.TRACKDRAW_API_KEY;
  if (!apiKey) {
    const error = new Error("TrackDraw API Key 未配置");
    error.statusCode = 401;
    error.userMessage = "API Key 无效";
    throw error;
  }
  const response = await fetch(`${TRACKDRAW_BASE_URL}${pathname}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    let detail = "";
    try {
      const problem = await response.json();
      detail = problem.detail || problem.title || "";
    } catch {
      detail = await response.text().catch(() => "");
    }
    const error = new Error(detail || `TrackDraw HTTP ${response.status}`);
    error.statusCode = response.status;
    if (response.status === 401 || response.status === 403) error.userMessage = "API Key 无效";
    else if (response.status === 404) error.userMessage = "项目不存在";
    else if (response.status === 429) error.userMessage = "TrackDraw 返回 429";
    else error.userMessage = "TrackDraw 服务异常";
    throw error;
  }
  return response.json();
}

function transportRulesFromDb() {
  const rows = db.prepare("SELECT * FROM transport_rules ORDER BY equipment_type").all();
  const rules = {};
  for (const row of rows) {
    const fallback = DEFAULT_TRANSPORT_RULES[row.equipment_type] || { name: equipmentLabel(row.equipment_type) };
    rules[row.equipment_type] = {
      name: fallback.name || equipmentLabel(row.equipment_type),
      qty: row.max_per_trip,
      people: row.people_required,
      cart: row.cart_required,
      minutes: row.trip_time_minutes,
      difficulty: row.difficulty,
      enabled: Boolean(row.enabled),
      note: row.note,
    };
  }
  return rules;
}

function countsForTrack(trackId) {
  const counts = { single: 0, sun: 0, gravity: 0, doubleGravity: 0, triple: 0, sandbag: 0, flag: 0 };
  for (const row of equipmentRows(trackId)) {
    counts[row.equipment_type] = Number(row.final_quantity || 0);
  }
  return counts;
}

app.get("/api/state", (req, res) => {
  if (!bracketStateCacheLoaded) {
    bracketStateCache = fs.existsSync(bracketStateFile) ? readJsonIfExists(bracketStateFile, null) : null;
    bracketStateCacheLoaded = true;
  }
  res.json(bracketStateCache);
});

app.post("/api/state", (req, res) => {
  bracketStateCache = req.body;
  bracketStateCacheLoaded = true;
  fs.writeFileSync(bracketStateFile, JSON.stringify(bracketStateCache, null, 2), "utf-8");
  res.json({ ok: true });
});

app.get("/api/tracks", (req, res) => {
  const currentTrackId = getCurrentTrackId();
  const rows = db.prepare("SELECT * FROM tracks ORDER BY updated_at DESC").all();
  res.json(rows.map((row) => ({
    ...trackFromRow(row),
    current: row.id === currentTrackId,
    equipmentSummary: trackSummary(row.id),
    selectedPlan: planRows(row.id).find((plan) => plan.selected) || null,
  })));
});

app.post("/api/tracks", (req, res) => {
  const now = Date.now();
  const id = req.body?.id || `track-${now}-${crypto.randomBytes(3).toString("hex")}`;
  const embedUrl = String(req.body?.trackdrawEmbedUrl || "").trim();
  const projectId = String(req.body?.trackdrawProjectId || parseTrackdrawProjectId(embedUrl)).trim();
  if (embedUrl && !projectId) return res.status(400).json({ error: "链接格式错误" });
  db.prepare(`
    INSERT INTO tracks
      (id, name, location, note, trackdraw_project_id, trackdraw_embed_url, sync_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(
    id,
    String(req.body?.name || projectId || "未同步赛道").trim(),
    "",
    "",
    projectId,
    normalizeTrackdrawEmbedUrl(embedUrl, projectId),
    now,
    now,
  );
  res.json({ ok: true, track: trackFromRow(getTrackRow(id), { includeChildren: true }) });
});

app.get("/api/tracks/current", (req, res) => {
  const id = getCurrentTrackId();
  const row = id ? getTrackRow(id) : null;
  res.json({ track: row ? trackFromRow(row, { includeChildren: true }) : null });
});

app.post("/api/tracks/:id/current", (req, res) => {
  const row = getTrackRow(req.params.id);
  if (!row) return res.status(404).json({ error: "track not found" });
  setSettingJson(CURRENT_TRACK_SETTING_KEY, req.params.id);
  res.json({ ok: true, track: trackFromRow(row, { includeChildren: true }) });
});

app.get("/api/tracks/:id", (req, res) => {
  const row = getTrackRow(req.params.id);
  if (!row) return res.status(404).json({ error: "track not found" });
  res.json(trackFromRow(row, { includeJson: true, includeChildren: true }));
});

app.put("/api/tracks/:id", (req, res) => {
  const row = getTrackRow(req.params.id);
  if (!row) return res.status(404).json({ error: "track not found" });
  const embedUrl = String(req.body?.trackdrawEmbedUrl || "").trim();
  const projectId = String(req.body?.trackdrawProjectId || parseTrackdrawProjectId(embedUrl)).trim();
  if (embedUrl && !projectId) return res.status(400).json({ error: "链接格式错误" });
  const now = Date.now();
  db.prepare(`
    UPDATE tracks
    SET name = ?, location = ?, note = ?, trackdraw_project_id = ?, trackdraw_embed_url = ?, updated_at = ?
    WHERE id = ?
  `).run(
    String(req.body?.name || row.name || projectId || "未同步赛道").trim(),
    "",
    "",
    projectId,
    normalizeTrackdrawEmbedUrl(embedUrl, projectId),
    now,
    req.params.id,
  );
  res.json({ ok: true, track: trackFromRow(getTrackRow(req.params.id), { includeChildren: true }) });
});

app.delete("/api/tracks/:id", (req, res) => {
  runTransaction(() => {
    db.prepare("DELETE FROM transport_plans WHERE track_id = ?").run(req.params.id);
    db.prepare("DELETE FROM track_unknown_objects WHERE track_id = ?").run(req.params.id);
    db.prepare("DELETE FROM track_equipment WHERE track_id = ?").run(req.params.id);
    db.prepare("DELETE FROM tracks WHERE id = ?").run(req.params.id);
    if (getCurrentTrackId() === req.params.id) setSettingJson(CURRENT_TRACK_SETTING_KEY, "");
  });
  res.json({ ok: true });
});

app.post("/api/trackdraw/parse", (req, res) => {
  const projectId = parseTrackdrawProjectId(req.body?.url);
  if (!projectId) return res.status(400).json({ error: "链接格式错误" });
  res.json({ projectId, embedUrl: normalizeTrackdrawEmbedUrl(req.body?.url, projectId) });
});

app.post("/api/tracks/:id/sync-trackdraw", async (req, res) => {
  const row = getTrackRow(req.params.id);
  if (!row) return res.status(404).json({ error: "track not found" });
  const projectId = row.trackdraw_project_id || parseTrackdrawProjectId(row.trackdraw_embed_url);
  if (!projectId) {
    db.prepare("UPDATE tracks SET sync_status = 'error', sync_error = ?, updated_at = ? WHERE id = ?").run("链接格式错误", Date.now(), req.params.id);
    return res.status(400).json({ error: "链接格式错误" });
  }
  try {
    db.prepare("UPDATE tracks SET sync_status = 'syncing', sync_error = '', updated_at = ? WHERE id = ?").run(Date.now(), req.params.id);
    await trackdrawFetch("/api/v1/me");
    await trackdrawFetch(`/api/v1/projects/${encodeURIComponent(projectId)}`);
    const trackJson = await trackdrawFetch(`/api/v1/projects/${encodeURIComponent(projectId)}/track`);
    const overlayJson = await trackdrawFetch(`/api/v1/projects/${encodeURIComponent(projectId)}/overlay`);
    const trackData = trackJson.data || trackJson;
    const overlayData = overlayJson.data || overlayJson;
    const field = overlayData.field || trackData.field || {};
    const routeLength = overlayData.readiness?.route_length_m ?? overlayData.route?.length_m ?? overlayData.duration_estimate?.route_length_m ?? null;
    const updatedAt = overlayData.updated_at || trackData.updated_at || null;
    runTransaction(() => {
      db.prepare(`
        UPDATE tracks
        SET name = ?,
            trackdraw_project_id = ?,
            track_json = ?,
            overlay_json = ?,
            field_width = ?,
            field_height = ?,
            route_length = ?,
            trackdraw_updated_at = ?,
            sync_status = 'success',
            sync_error = '',
            updated_at = ?
        WHERE id = ?
      `).run(overlayData.title || trackData.title || row.name || projectId, projectId, JSON.stringify(trackJson), JSON.stringify(overlayJson), field.width ?? null, field.height ?? null, routeLength, updatedAt, Date.now(), req.params.id);
      persistAutoEquipment(req.params.id, trackJson, overlayJson);
    });
    res.json({ ok: true, track: trackFromRow(getTrackRow(req.params.id), { includeJson: true, includeChildren: true }) });
  } catch (error) {
    const message = error.userMessage || error.message || "TrackDraw 服务异常";
    db.prepare("UPDATE tracks SET sync_status = 'error', sync_error = ?, updated_at = ? WHERE id = ?").run(message, Date.now(), req.params.id);
    res.status(error.statusCode && error.statusCode < 500 ? error.statusCode : 500).json({ error: message });
  }
});

app.get("/api/tracks/:id/equipment", (req, res) => {
  res.json({ equipment: equipmentRows(req.params.id) });
});

app.post("/api/tracks/:id/equipment", (req, res) => {
  const rows = Array.isArray(req.body?.equipment) ? req.body.equipment : [];
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO track_equipment (track_id, equipment_type, auto_quantity, corrected_quantity, final_quantity, note)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(track_id, equipment_type) DO UPDATE SET
      corrected_quantity = excluded.corrected_quantity,
      final_quantity = excluded.final_quantity,
      note = excluded.note
  `);
  runTransaction(() => {
    for (const row of rows) {
      const autoQuantity = Math.max(0, Math.floor(Number(row.auto_quantity ?? row.autoQuantity ?? 0)));
      const correctedRaw = row.corrected_quantity ?? row.correctedQuantity;
      const corrected = correctedRaw === "" || correctedRaw === null || correctedRaw === undefined ? null : Math.max(0, Math.floor(Number(correctedRaw) || 0));
      const type = row.equipment_type || row.equipmentType;
      const assigned = unknownAssignedCounts(req.params.id)[type] || 0;
      stmt.run(req.params.id, type, autoQuantity, corrected, corrected ?? (autoQuantity + assigned), String(row.note || ""));
    }
    refreshEquipmentFinalQuantities(req.params.id);
    db.prepare("UPDATE tracks SET updated_at = ? WHERE id = ?").run(now, req.params.id);
  });
  res.json({ ok: true, equipment: equipmentRows(req.params.id) });
});

app.get("/api/tracks/:id/unknown-objects", (req, res) => {
  res.json({ unknownObjects: unknownRows(req.params.id) });
});

app.post("/api/tracks/:id/unknown-objects", (req, res) => {
  const items = Array.isArray(req.body?.unknownObjects) ? req.body.unknownObjects : [];
  const stmt = db.prepare(`
    UPDATE track_unknown_objects
    SET assigned_equipment_type = ?, ignored = ?
    WHERE id = ? AND track_id = ?
  `);
  runTransaction(() => {
    for (const item of items) {
      stmt.run(String(item.assigned_equipment_type || item.assignedEquipmentType || ""), item.ignored ? 1 : 0, item.id, req.params.id);
    }
    refreshEquipmentFinalQuantities(req.params.id);
  });
  res.json({ ok: true, unknownObjects: unknownRows(req.params.id) });
});

app.get("/api/transport/rules", (req, res) => {
  res.json({ rules: transportRulesFromDb() });
});

app.post("/api/transport/rules", (req, res) => {
  const rules = req.body?.rules || {};
  runTransaction(() => {
    for (const [type, rule] of Object.entries(rules)) {
      upsertTransportRule.run(
        type,
        Math.max(1, Math.floor(Number(rule.people ?? rule.people_required ?? 1))),
        Math.max(1, Math.floor(Number(rule.qty ?? rule.max_per_trip ?? 1))),
        Number(rule.minutes ?? rule.trip_time_minutes ?? 1) || 1,
        Math.max(0, Math.floor(Number(rule.cart ?? rule.cart_required ?? 0))),
        Number(rule.difficulty ?? 1) || 1,
        rule.enabled === false ? 0 : 1,
        String(rule.note || ""),
      );
    }
  });
  res.json({ ok: true, rules: transportRulesFromDb() });
});

app.post("/api/tracks/:id/transport-plans/calculate", (req, res) => {
  const row = getTrackRow(req.params.id);
  if (!row) return res.status(404).json({ error: "track not found" });
  try {
    const config = {
      ...(req.body?.config || {}),
      counts: { ...countsForTrack(req.params.id), ...(req.body?.config?.counts || {}) },
      rules: { ...transportRulesFromDb(), ...(req.body?.config?.rules || {}) },
    };
    const result = calculateTransportPlans(config);
    const now = Date.now();
    runTransaction(() => {
      db.prepare("DELETE FROM transport_plans WHERE track_id = ?").run(req.params.id);
      const insertPlan = db.prepare(`
        INSERT INTO transport_plans
          (id, track_id, plan_type, title, people_count, used_people_count, estimated_minutes, idle_minutes, fatigue_score, trip_imbalance, plan_json, selected, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      result.plans.forEach((plan, index) => {
        insertPlan.run(
          `plan-${now}-${index}`,
          req.params.id,
          "search",
          `方案 ${index + 1}`,
          plan.peopleCount,
          plan.usedCount,
          plan.makespan,
          plan.totalIdle,
          plan.fatigue,
          plan.tripImbalance || 0,
          JSON.stringify({ ...plan, config: result.config, meta: result.meta }),
          index === 0 ? 1 : 0,
          now,
          now,
        );
      });
      db.prepare("UPDATE tracks SET updated_at = ? WHERE id = ?").run(now, req.params.id);
    });
    res.json({ ok: true, plans: planRows(req.params.id), meta: result.meta });
  } catch (error) {
    res.status(500).json({ error: error.message || "transport plan failed" });
  }
});

app.get("/api/tracks/:id/transport-plans", (req, res) => {
  res.json({ plans: planRows(req.params.id) });
});

app.post("/api/tracks/:id/transport-plans/:planId/select", (req, res) => {
  runTransaction(() => {
    db.prepare("UPDATE transport_plans SET selected = 0 WHERE track_id = ?").run(req.params.id);
    db.prepare("UPDATE transport_plans SET selected = 1, updated_at = ? WHERE track_id = ? AND id = ?").run(Date.now(), req.params.id, req.params.planId);
  });
  res.json({ ok: true, plans: planRows(req.params.id) });
});

app.get("/api/pilots", (req, res) => {
  const rows = db.prepare("SELECT * FROM pilots ORDER BY updated_at, id").all();
  res.json(rows.map(pilotFromRow));
});

app.post("/api/pilots", (req, res) => {
  const pilots = Array.isArray(req.body) ? req.body : [];
  const now = Date.now();
  runTransaction(() => {
    db.prepare("DELETE FROM pilots").run();
    for (const pilot of pilots) {
      upsertPilot.run(
        pilot.id,
        pilot.name || pilot.id,
        pilot.rates || "",
        pilot.rateProfile ? JSON.stringify(pilot.rateProfile) : null,
        pilot.note || "",
        JSON.stringify(pilot.channelConfig || defaultChannelConfig),
        now,
      );
    }
  });
  res.json({ ok: true });
});

app.get("/api/events", (req, res) => {
  const rows = db.prepare("SELECT * FROM training_events ORDER BY COALESCE(started_at, created_at) DESC").all();
  res.json(rows.map(eventFromRow));
});

app.get("/api/events/:id/detail", (req, res) => {
  const row = db.prepare("SELECT * FROM training_events WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "event not found" });

  const event = eventFromRow(row);
  const pilotRows = db.prepare("SELECT * FROM pilots").all();
  const pilots = new Map(pilotRows.map((pilot) => [pilot.id, pilotFromRow(pilot)]));
  const cachedOverview = readCachedEventOverview(req.params.id);
  const overview = req.query.recompute === "1"
    ? computeEventOverview(event, req.params.id)
    : { ...cachedOverview, sampleCounts: {} };
  if (req.query.recompute === "1") persistEventOverview(req.params.id, overview);
  const sampleCountRows = db.prepare(`
    SELECT pilot_id, COUNT(*) AS count
    FROM training_samples
    WHERE event_id = ?
    GROUP BY pilot_id
  `).all(req.params.id);
  for (const countRow of sampleCountRows) {
    overview.sampleCounts[countRow.pilot_id] = countRow.count;
  }
  const statsByPilot = new Map(overview.stats.map((stat) => [stat.pilot_id, stat]));
  const segmentsByPilot = new Map();
  for (const segment of overview.segments) {
    const list = segmentsByPilot.get(segment.pilot_id) || [];
    list.push({
      type: segment.type,
      startedAt: segment.started_at,
      endedAt: segment.ended_at,
      durationMs: segment.duration_ms,
    });
    segmentsByPilot.set(segment.pilot_id, list);
  }

  res.json({
    event,
    generatedAt: Date.now(),
    participants: event.participants.map((participant) => {
      const pilot = pilots.get(participant.pilotId);
      const stat = statsByPilot.get(participant.pilotId);
      const segments = segmentsByPilot.get(participant.pilotId) || [];
      return {
        ...participant,
        pilotName: pilot?.name || participant.pilotId,
        rates: pilot?.rates || "",
        totalFlightMs: stat?.total_flight_ms || 0,
        utilization: stat?.utilization || 0,
        idleMs: stat?.idle_ms ?? null,
        totalTurtleMs: stat?.total_turtle_ms || 0,
        sampleCount: overview.sampleCounts[participant.pilotId] || 0,
        samples: [],
        segments,
      };
    }),
  });
});

app.delete("/api/events/:id", (req, res) => {
  runTransaction(() => {
    db.prepare("DELETE FROM training_event_stats WHERE event_id = ?").run(req.params.id);
    db.prepare("DELETE FROM training_segments WHERE event_id = ?").run(req.params.id);
    db.prepare("DELETE FROM training_samples WHERE event_id = ?").run(req.params.id);
    db.prepare("DELETE FROM training_events WHERE id = ?").run(req.params.id);
  });
  res.json({ ok: true });
});

const upsertEvent = db.prepare(`
  INSERT INTO training_events (id, name, started_at, ended_at, active, participants_json, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    started_at = excluded.started_at,
    ended_at = excluded.ended_at,
    active = excluded.active,
    participants_json = excluded.participants_json,
    updated_at = excluded.updated_at
`);

app.post("/api/events", (req, res) => {
  const events = Array.isArray(req.body) ? req.body : [];
  const names = new Map();
  for (const event of events) {
    const name = String(event.name || "").trim();
    if (!name) return res.status(400).json({ error: "training event name is required" });
    const existingId = names.get(name);
    if (existingId && existingId !== event.id) return res.status(409).json({ error: `duplicate training event name: ${name}` });
    const duplicate = db.prepare("SELECT id FROM training_events WHERE name = ? AND id <> ?").get(name, event.id);
    if (duplicate) return res.status(409).json({ error: `duplicate training event name: ${name}` });
    names.set(name, event.id);
  }
  const now = Date.now();
  runTransaction(() => {
    for (const event of events) {
      upsertEvent.run(
        event.id,
        event.name || event.id,
        event.startedAt || null,
        event.endedAt || null,
        event.active ? 1 : 0,
        JSON.stringify(event.participants || []),
        event.createdAt || event.startedAt || now,
        now,
      );
    }
  });
  res.json({ ok: true });
});

app.post("/api/events/start", (req, res) => {
  const now = Date.now();
  const id = req.body?.id || `event-${now}`;
  const name = String(req.body?.name || "训练").trim();
  const startedAt = req.body?.startedAt || now;
  const duplicate = db.prepare("SELECT id FROM training_events WHERE name = ? AND id <> ?").get(name, id);
  if (duplicate) return res.status(409).json({ error: `duplicate training event name: ${name}` });
  db.prepare("UPDATE training_events SET active = 0, updated_at = ? WHERE active = 1").run(now);
  upsertEvent.run(
    id,
    name,
    startedAt,
    null,
    1,
    JSON.stringify(req.body?.participants || []),
    req.body?.createdAt || now,
    now,
  );
  res.json({ ok: true, event: eventFromRow(db.prepare("SELECT * FROM training_events WHERE id = ?").get(id)) });
});

app.post("/api/events/:id/end", (req, res) => {
  const now = Date.now();
  db.prepare("UPDATE training_events SET active = 0, ended_at = ?, updated_at = ? WHERE id = ?").run(now, now, req.params.id);
  res.json({ ok: true, event: eventFromRow(db.prepare("SELECT * FROM training_events WHERE id = ?").get(req.params.id)) });
});

app.get("/api/training-live", (req, res) => {
  res.json({
    receiverCount: getReceiverCount(),
    receivers: getReceivers(),
    samples: [],
  });
});

app.get("/api/training-csv/status", (req, res) => {
  res.json(getTrainingCsvStatus());
});

app.post("/api/training-live", (req, res) => {
  if (req.body?.receiverCount) setReceiverCount(req.body.receiverCount);
  res.json({ ok: true, receiverCount: getReceiverCount(), receivers: getReceivers(), samples: [] });
});

app.post("/api/receivers/count", (req, res) => {
  res.json({ ok: true, receiverCount: setReceiverCount(req.body?.receiverCount) });
});

app.post("/api/receivers/:id/bind", (req, res) => {
  const receiverId = Math.max(1, Math.min(16, Number(req.params.id) || 1));
  const now = Date.now();
  db.prepare(`
    INSERT INTO receivers (id, name, online, binding, bind_requested_at, last_seen_at)
    VALUES (?, ?, 1, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      online = 1,
      binding = 1,
      bind_requested_at = excluded.bind_requested_at,
      last_seen_at = excluded.last_seen_at
  `).run(receiverId, `接收机 ${receiverId}`, now, now);
  res.json({ ok: true, receiverId, bindRequestedAt: now, receivers: getReceivers() });
});

const insertSample = db.prepare(`
  INSERT INTO training_samples
    (event_id, pilot_id, receiver_id, time, ch1, ch2, ch3, ch4, ch5, ch6, ch7, ch8, armed, flying, turtle)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const lastSample = db.prepare("SELECT time FROM training_samples WHERE event_id = ? AND pilot_id = ? ORDER BY time DESC LIMIT 1");
const lastSampleDetail = db.prepare(`
  SELECT time, armed, flying, turtle
  FROM training_samples
  WHERE event_id = ? AND pilot_id = ?
  ORDER BY time DESC
  LIMIT 1
`);

app.post("/api/training-events/:id/samples", (req, res) => {
  const samples = Array.isArray(req.body?.samples) ? req.body.samples : [];
  let inserted = 0;
  runTransaction(() => {
    for (const sample of samples) {
      const previous = lastSample.get(req.params.id, sample.pilotId);
      if (previous && sample.time - previous.time < 200) continue;
      insertSample.run(
        req.params.id,
        sample.pilotId,
        Number(sample.receiverId) || 0,
        Number(sample.time) || Date.now(),
        sampleChannelValue(sample, "ch1"),
        sampleChannelValue(sample, "ch2"),
        sampleChannelValue(sample, "ch3"),
        sampleChannelValue(sample, "ch4"),
        sampleChannelValue(sample, "ch5"),
        sampleChannelValue(sample, "ch6"),
        sampleChannelValue(sample, "ch7"),
        sampleChannelValue(sample, "ch8"),
        sample.armed ? 1 : 0,
        sample.flying ? 1 : 0,
        sample.turtle ? 1 : 0,
      );
      inserted += 1;
    }
  });
  res.json({ ok: true, inserted });
});

app.get("/api/training-events/:id/samples", (req, res) => {
  const since = Number(req.query.since || 0);
  const rows = db.prepare(`
    SELECT * FROM training_samples
    WHERE event_id = ? AND time >= ?
    ORDER BY time ASC
    LIMIT 20000
  `).all(req.params.id, since);
  res.json(rows.map((row) => ({
    time: row.time,
    pilotId: row.pilot_id,
    receiverId: row.receiver_id,
    armed: Boolean(row.armed),
    flying: Boolean(row.flying),
    turtle: Boolean(row.turtle),
    channels: {
      ch1: row.ch1,
      ch2: row.ch2,
      ch3: row.ch3,
      ch4: row.ch4,
      ch5: row.ch5,
      ch6: row.ch6,
      ch7: row.ch7,
      ch8: row.ch8,
    },
  })));
});

const upsertStat = db.prepare(`
  INSERT INTO training_event_stats
    (event_id, pilot_id, total_flight_ms, utilization, idle_ms, total_turtle_ms, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(event_id, pilot_id) DO UPDATE SET
    total_flight_ms = excluded.total_flight_ms,
    utilization = excluded.utilization,
    idle_ms = excluded.idle_ms,
    total_turtle_ms = excluded.total_turtle_ms,
    updated_at = excluded.updated_at
`);

const activeEventQuery = db.prepare(`
  SELECT *
  FROM training_events
  WHERE active = 1
  ORDER BY COALESCE(started_at, created_at) DESC
  LIMIT 1
`);
const allEventsQuery = db.prepare("SELECT * FROM training_events ORDER BY COALESCE(started_at, created_at) DESC");
const allPilotsQuery = db.prepare("SELECT * FROM pilots");
const COACH_SNAPSHOT_INTERVAL_MS = 5000;
const COACH_WINDOW_MS = 15 * 60 * 1000;
const COACH_STALE_AFTER_MS = 15000;
const coachSnapshotStore = {
  activeEventId: null,
  generatedAt: null,
  stale: true,
  event: null,
  pilots: [],
  error: "",
};
const COACH_LLM_CONFIG_KEY = "coachLlmConfig";
const DEFAULT_COACH_LLM_CONFIG = {
  enabled: false,
  endpoint: "https://api.deepseek.com/chat/completions",
  model: "deepseekv4pro",
  apiKey: "",
  systemPrompt: [
    "你是 FPV 训练现场助教，只根据输入的 coachSnapshot 判断。",
    "输出必须简短、可播报，不要解释推理过程。",
    "message 不超过 36 个中文字，reason 不超过 24 个中文字。",
    "只输出符合 JSON Schema 的对象。",
  ].join("\n"),
  temperature: 0.2,
  timeoutMs: 12000,
  autoIntervalMinutes: 5,
};
const coachLlmRuntime = {
  signatures: new Map(),
  suggestions: new Map(),
  autoRequestedAt: new Map(),
  autoCursor: 0,
  eventSummary: null,
  inFlight: new Set(),
  lastError: "",
};
const upsertReceiverSeen = db.prepare(`
  INSERT INTO receivers (id, name, online, binding, bind_requested_at, last_seen_at)
  VALUES (?, ?, 1, 0, NULL, ?)
  ON CONFLICT(id) DO UPDATE SET
    online = 1,
    binding = 0,
    last_seen_at = excluded.last_seen_at
`);
const markOfflineReceivers = db.prepare("UPDATE receivers SET online = 0 WHERE last_seen_at < ?");
const lastSegmentQuery = db.prepare(`
  SELECT id, type, started_at, ended_at, duration_ms
  FROM training_segments
  WHERE event_id = ? AND pilot_id = ?
  ORDER BY ended_at DESC, id DESC
  LIMIT 1
`);
const insertTrainingSegment = db.prepare(`
  INSERT INTO training_segments (event_id, pilot_id, type, started_at, ended_at, duration_ms)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const updateTrainingSegment = db.prepare(`
  UPDATE training_segments
  SET ended_at = ?, duration_ms = ?
  WHERE id = ?
`);
const segmentTotalsQuery = db.prepare(`
  SELECT
    COALESCE(SUM(CASE WHEN type = 'flight' THEN MAX(0, MIN(ended_at, ?) - MAX(started_at, ?)) ELSE 0 END), 0) AS total_flight_ms,
    COALESCE(SUM(CASE WHEN type = 'turtle' THEN MAX(0, MIN(ended_at, ?) - MAX(started_at, ?)) ELSE 0 END), 0) AS total_turtle_ms,
    MAX(CASE WHEN type = 'flight' THEN MIN(ended_at, ?) ELSE NULL END) AS last_flight_end
  FROM training_segments
  WHERE event_id = ? AND pilot_id = ? AND ended_at > ? AND started_at < ?
`);

const trainingCsvHeader = [
  "time_iso",
  "time_ms",
  "source_time",
  "event_id",
  "event_name",
  "pilot_id",
  "pilot_name",
  "receiver_id",
  "state",
  "mode",
  "armed",
  "flying",
  "turtle",
  "idle",
  "throttle_spread",
  "lq",
  "rssi",
  "raw_ch1",
  "raw_ch2",
  "raw_ch3",
  "raw_ch4",
  "raw_ch5",
  "raw_ch6",
  "raw_ch7",
  "raw_ch8",
  "ch1",
  "ch2",
  "ch3",
  "ch4",
  "ch5",
  "ch6",
  "ch7",
  "ch8",
];

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function ensureTrainingCsvFile() {
  if (fs.existsSync(trainingCsvFile)) return;
  fs.writeFileSync(trainingCsvFile, `${trainingCsvHeader.join(",")}\n`, "utf-8");
}

function refreshTrainingCsvFileSize() {
  try {
    trainingCsvStatus.fileSizeBytes = fs.existsSync(trainingCsvFile) ? fs.statSync(trainingCsvFile).size : 0;
  } catch (error) {
    trainingCsvStatus.lastError = error.message;
  }
}

function getTrainingCsvStatus() {
  refreshTrainingCsvFileSize();
  return { ...trainingCsvStatus };
}

function flushTrainingCsvQueue() {
  if (trainingCsvStatus.flushInFlight || pendingTrainingCsvLines.length === 0) return;
  ensureTrainingCsvFile();
  const lines = pendingTrainingCsvLines.splice(0, pendingTrainingCsvLines.length);
  const data = lines.join("");
  const bytes = Buffer.byteLength(data);
  const startedAt = Date.now();
  trainingCsvStatus.flushInFlight = true;
  trainingCsvStatus.queuedRows = pendingTrainingCsvLines.length;
  trainingCsvStatus.queuedBytes = pendingTrainingCsvLines.reduce((total, line) => total + Buffer.byteLength(line), 0);

  fs.promises.appendFile(trainingCsvFile, data, "utf-8")
    .then(() => fs.promises.stat(trainingCsvFile))
    .then((stat) => {
      trainingCsvStatus.writtenRows += lines.length;
      trainingCsvStatus.bytesWritten += bytes;
      trainingCsvStatus.fileSizeBytes = stat.size;
      trainingCsvStatus.lastFlushMs = Date.now() - startedAt;
      trainingCsvStatus.lastFlushAt = Date.now();
      trainingCsvStatus.lastError = "";
    })
    .catch((error) => {
      pendingTrainingCsvLines.unshift(...lines);
      trainingCsvStatus.queuedRows = pendingTrainingCsvLines.length;
      trainingCsvStatus.queuedBytes = pendingTrainingCsvLines.reduce((total, line) => total + Buffer.byteLength(line), 0);
      trainingCsvStatus.lastError = error.message;
    })
    .finally(() => {
      trainingCsvStatus.flushInFlight = false;
    });
}

function queueTrainingCsvSample(event, pilot, participant, sample) {
  const stateType = stateTypeFromSample(sample);
  if (stateType !== "flight" && stateType !== "turtle") return;
  const row = [
    new Date(sample.time).toISOString(),
    sample.time,
    sample.sourceTime ?? "",
    event.id,
    event.name,
    pilot.id,
    pilot.name,
    participant.receiverId,
    stateType,
    sample.mode || "",
    sample.armed ? 1 : 0,
    sample.flying ? 1 : 0,
    sample.turtle ? 1 : 0,
    sample.idle ? 1 : 0,
    Math.round(sample.throttleSpread || 0),
    sample.lq ?? "",
    sample.rssi ?? "",
    ...(sample.rawChannels || []).slice(0, 8),
    sampleChannelValue(sample, "ch1"),
    sampleChannelValue(sample, "ch2"),
    sampleChannelValue(sample, "ch3"),
    sampleChannelValue(sample, "ch4"),
    sampleChannelValue(sample, "ch5"),
    sampleChannelValue(sample, "ch6"),
    sampleChannelValue(sample, "ch7"),
    sampleChannelValue(sample, "ch8"),
  ];
  const line = `${row.map(csvCell).join(",")}\n`;
  pendingTrainingCsvLines.push(line);
  trainingCsvStatus.queuedRows = pendingTrainingCsvLines.length;
  trainingCsvStatus.queuedBytes += Buffer.byteLength(line);
  if (pendingTrainingCsvLines.length >= 50 || trainingCsvStatus.queuedBytes >= 64 * 1024) {
    flushTrainingCsvQueue();
  }
}

function stateTypeFromSample(sample) {
  return sample?.turtle ? "turtle" : sample?.flying ? "flight" : "idle";
}

function refreshReceiverState(now = Date.now(), writeDb = false) {
  if (writeDb && now - lastReceiverOfflineMarkAt >= RECEIVER_DB_WRITE_INTERVAL_MS) {
    markOfflineReceivers.run(now - RECEIVER_OFFLINE_AFTER_MS);
    lastReceiverOfflineMarkAt = now;
  }
  const activeReceiverIds = Object.entries(serverLiveState.latestSamplesByReceiver)
    .filter(([, sample]) => now - Number(sample?.time || 0) <= RECEIVER_OFFLINE_AFTER_MS)
    .map(([receiverId]) => Number(receiverId))
    .filter((receiverId) => Number.isFinite(receiverId));
  serverLiveState.receiverState.connected = activeReceiverIds.length > 0;
  serverLiveState.receiverState.receiverCount = activeReceiverIds.length;
  serverLiveState.receiverState.maxReceiverId = Math.max(0, ...activeReceiverIds);
  if (!activeReceiverIds.length && serverLiveState.receiverState.lastDataAt && now - serverLiveState.receiverState.lastDataAt > RECEIVER_OFFLINE_AFTER_MS) {
    serverLiveState.receiverState.lastReceiverId = null;
  }
}

function updateReceiversFromSamples(samples, receivedAt) {
  const receiverIds = new Set();
  for (const sample of samples) {
    receiverIds.add(sample.receiverId);
    serverLiveState.latestSamplesByReceiver[sample.receiverId] = sample;
    const lastWriteAt = receiverDbWriteTimes.get(sample.receiverId) || 0;
    if (receivedAt - lastWriteAt >= RECEIVER_DB_WRITE_INTERVAL_MS) {
      upsertReceiverSeen.run(sample.receiverId, `RX ${sample.receiverId}`, receivedAt);
      receiverDbWriteTimes.set(sample.receiverId, receivedAt);
    }
  }
  refreshReceiverState(receivedAt);
  serverLiveState.receiverState.connected = true;
  serverLiveState.receiverState.packetCount += 1;
  serverLiveState.receiverState.lastDataAt = receivedAt;
  serverLiveState.receiverState.lastReceiverId = [...receiverIds].pop() || null;
  serverLiveState.receiverState.error = "";
}

function getRuntimeForEvent(event, now = Date.now()) {
  let runtime = runtimeEvents.get(event.id);
  if (!runtime) {
    runtime = {
      event,
      participantByReceiver: new Map(),
      pilotsById: new Map(),
      recentByPilot: new Map(),
      lastPersistedByPilot: new Map(),
      lastStatsRefreshByPilot: new Map(),
      lastCsvStateByPilot: new Map(),
      contextLoadedAt: 0,
    };
    runtimeEvents.set(event.id, runtime);
  }

  if (now - runtime.contextLoadedAt > 1000) {
    runtime.event = event;
    runtime.participantByReceiver = new Map(
      event.participants
        .map((participant) => [Number(participant.receiverId), participant])
        .filter(([receiverId]) => Number.isFinite(receiverId)),
    );
    runtime.pilotsById = new Map(allPilotsQuery.all().map((row) => {
      const pilot = pilotFromRow(row);
      return [pilot.id, pilot];
    }));
    runtime.contextLoadedAt = now;
  }

  return runtime;
}

function getCsvRuntimeForEvent(event, now = Date.now()) {
  let runtime = csvRuntimeEvents.get(event.id);
  if (!runtime) {
    runtime = {
      event,
      participantByReceiver: new Map(),
      pilotsById: new Map(),
      recentByPilot: new Map(),
      contextLoadedAt: 0,
    };
    csvRuntimeEvents.set(event.id, runtime);
  }

  if (now - runtime.contextLoadedAt > 1000) {
    runtime.event = event;
    runtime.participantByReceiver = new Map(
      event.participants
        .map((participant) => [Number(participant.receiverId), participant])
        .filter(([receiverId]) => Number.isFinite(receiverId)),
    );
    runtime.pilotsById = new Map(allPilotsQuery.all().map((row) => {
      const pilot = pilotFromRow(row);
      return [pilot.id, pilot];
    }));
    runtime.contextLoadedAt = now;
  }

  return runtime;
}

function processTrainingCsvSample(event, pilot, participant, rawSample, runtime, receivedAt) {
  const pilotId = participant.pilotId;
  const receiverId = Number(participant.receiverId) || rawSample.receiverId;
  const sampleTime = Number(rawSample.time) || receivedAt;
  const trainingWindow = getParticipantTrainingWindow(event, participant, receivedAt);
  if (sampleTime < trainingWindow.start || sampleTime > trainingWindow.end) return;

  const recentBefore = (runtime.recentByPilot.get(pilotId) || [])
    .filter((sample) => sample.time >= sampleTime - RECENT_SAMPLE_WINDOW_MS);
  const baseSample = { ...rawSample, pilotId, receiverId, time: sampleTime };
  const state = getPilotState(pilot, baseSample, [...recentBefore, baseSample]);
  const sample = {
    ...baseSample,
    mode: state.mode,
    armed: state.armed,
    flying: state.flying,
    turtle: state.turtle,
    idle: state.idle,
    throttleSpread: state.throttleSpread,
  };

  recentBefore.push(sample);
  runtime.recentByPilot.set(pilotId, recentBefore.slice(-180));
  queueTrainingCsvSample(event, pilot, participant, sample);
}

function appendTrainingInterval(eventId, pilotId, type, startedAt, endedAt) {
  if (!type || endedAt <= startedAt) return;
  const lastSegment = lastSegmentQuery.get(eventId, pilotId);
  if (lastSegment && lastSegment.type === type && startedAt <= lastSegment.ended_at + MAX_SAMPLE_GAP_MS) {
    const nextEndedAt = Math.max(lastSegment.ended_at, endedAt);
    updateTrainingSegment.run(nextEndedAt, Math.max(0, nextEndedAt - lastSegment.started_at), lastSegment.id);
    return;
  }
  insertTrainingSegment.run(eventId, pilotId, type, startedAt, endedAt, Math.max(0, endedAt - startedAt));
}

function refreshPilotStatsFromSegments(event, pilotId, now = Date.now()) {
  const trainingWindow = getParticipantTrainingWindow(event, pilotId, now);
  const eventStart = trainingWindow.start;
  const eventEnd = trainingWindow.end;
  const totals = segmentTotalsQuery.get(
    eventEnd,
    eventStart,
    eventEnd,
    eventStart,
    eventEnd,
    event.id,
    pilotId,
    eventStart,
    eventEnd,
  );
  const totalFlightMs = Math.round(totals?.total_flight_ms || 0);
  const totalTurtleMs = Math.round(totals?.total_turtle_ms || 0);
  const idleMs = totals?.last_flight_end === null || totals?.last_flight_end === undefined
    ? null
    : Math.max(0, eventEnd - totals.last_flight_end);
  upsertStat.run(
    event.id,
    pilotId,
    totalFlightMs,
    totalFlightMs / Math.max(1, eventEnd - eventStart),
    idleMs,
    totalTurtleMs,
    now,
  );
}

function getLastPersistedSample(runtime, eventId, pilotId) {
  if (!runtime.lastPersistedByPilot.has(pilotId)) {
    const row = lastSampleDetail.get(eventId, pilotId);
    runtime.lastPersistedByPilot.set(pilotId, row || null);
  }
  return runtime.lastPersistedByPilot.get(pilotId);
}

function refreshPilotStatsThrottled(runtime, event, pilotId, now = Date.now(), force = false) {
  const lastRefreshAt = runtime.lastStatsRefreshByPilot.get(pilotId) || 0;
  if (!force && now - lastRefreshAt < STATS_REFRESH_INTERVAL_MS) return;
  refreshPilotStatsFromSegments(event, pilotId, now);
  runtime.lastStatsRefreshByPilot.set(pilotId, now);
}

function persistProcessedSample(event, pilot, participant, rawSample, runtime, receivedAt) {
  const pilotId = participant.pilotId;
  const receiverId = Number(participant.receiverId) || rawSample.receiverId;
  const sampleTime = Number(rawSample.time) || receivedAt;
  const recentBefore = (runtime.recentByPilot.get(pilotId) || [])
    .filter((sample) => sample.time >= sampleTime - RECENT_SAMPLE_WINDOW_MS);
  const baseSample = { ...rawSample, pilotId, receiverId, time: sampleTime };
  const state = getPilotState(pilot, baseSample, [...recentBefore, baseSample]);
  const sample = {
    ...baseSample,
    mode: state.mode,
    armed: state.armed,
    flying: state.flying,
    turtle: state.turtle,
    idle: state.idle,
    throttleSpread: state.throttleSpread,
  };

  recentBefore.push(sample);
  runtime.recentByPilot.set(pilotId, recentBefore.slice(-120));
  serverLiveState.latestSamplesByReceiver[receiverId] = sample;

  const trainingWindow = getParticipantTrainingWindow(event, participant, receivedAt);
  if (sampleTime < trainingWindow.start || sampleTime > trainingWindow.end) {
    refreshPilotStatsThrottled(runtime, event, pilotId, receivedAt);
    return sample;
  }

  const previous = getLastPersistedSample(runtime, event.id, pilotId);
  if (previous && sampleTime <= previous.time) return sample;
  if (previous && sampleTime - previous.time < SAMPLE_WRITE_INTERVAL_MS) return sample;

  insertSample.run(
    event.id,
    pilotId,
    receiverId,
    sampleTime,
    sampleChannelValue(sample, "ch1"),
    sampleChannelValue(sample, "ch2"),
    sampleChannelValue(sample, "ch3"),
    sampleChannelValue(sample, "ch4"),
    sampleChannelValue(sample, "ch5"),
    sampleChannelValue(sample, "ch6"),
    sampleChannelValue(sample, "ch7"),
    sampleChannelValue(sample, "ch8"),
    sample.armed ? 1 : 0,
    sample.flying ? 1 : 0,
    sample.turtle ? 1 : 0,
  );

  const persistedSample = {
    time: sampleTime,
    armed: sample.armed ? 1 : 0,
    flying: sample.flying ? 1 : 0,
    turtle: sample.turtle ? 1 : 0,
  };
  runtime.lastPersistedByPilot.set(pilotId, persistedSample);

  const crossedInputBreak = previous &&
    runtime.inputInterruptedAt &&
    runtime.inputInterruptedAt >= previous.time &&
    runtime.inputInterruptedAt <= sampleTime;
  if (previous && !crossedInputBreak && sampleTime - previous.time <= MAX_SAMPLE_GAP_MS) {
    const intervalStart = Math.max(previous.time, trainingWindow.start);
    const intervalEnd = Math.min(sampleTime, trainingWindow.end);
    appendTrainingInterval(event.id, pilotId, stateTypeFromSample(previous), intervalStart, intervalEnd);
  }
  refreshPilotStatsThrottled(runtime, event, pilotId, receivedAt);
  return sample;
}

function buildServerLiveState(event, now = Date.now()) {
  const overview = event ? readCachedEventOverview(event.id) : { stats: [], segments: [] };
  const participantByPilot = new Map((event?.participants || []).map((participant) => [participant.pilotId, participant]));
  const summaries = {};
  for (const stat of overview.stats || []) {
    const trainingWindow = event ? getParticipantTrainingWindow(event, participantByPilot.get(stat.pilot_id) || stat.pilot_id, now) : { start: now, end: now };
    const summaryEnd = event?.active ? now : trainingWindow.end;
    const totalFlightMs = stat.total_flight_ms || 0;
    const idleBase = stat.idle_ms ?? null;
    const updatedAt = stat.updated_at || now;
    const idleMs = idleBase === null ? null : Math.max(0, idleBase + Math.max(0, summaryEnd - updatedAt));
    summaries[stat.pilot_id] = {
      pilotId: stat.pilot_id,
      totalFlightMs,
      utilization: totalFlightMs / Math.max(1, summaryEnd - trainingWindow.start),
      idleMs,
      totalTurtleMs: stat.total_turtle_ms || 0,
      updatedAt: now,
    };
  }

  return {
    version: 3,
    serverManaged: true,
    updatedAt: now,
    event,
    events: allEventsQuery.all().map(eventFromRow),
    participants: event?.participants || [],
    summaries,
    bandsByPilot: bandsByPilotFromSegments(overview.segments || []),
    csvWrite: getTrainingCsvStatus(),
    latestSamplesByReceiver: serverLiveState.latestSamplesByReceiver,
    receiverState: serverLiveState.receiverState,
  };
}

function maybeBuildServerLiveState(event, now = Date.now(), force = false) {
  if (!force && now - (serverLiveState.lastStateBroadcastAt || 0) < LIVE_STATE_BROADCAST_INTERVAL_MS) return null;
  serverLiveState.lastStateBroadcastAt = now;
  return buildServerLiveState(event, now);
}

function processServerSerialPacket(packet, { receivedAt = Date.now() } = {}) {
  try {
    const rawSamples = parseSerialPacket(packet, receivedAt);
    if (!rawSamples.length) return null;

    updateReceiversFromSamples(rawSamples, receivedAt);
    const eventRow = activeEventQuery.get();
    if (!eventRow) return maybeBuildServerLiveState(null, receivedAt);

    const event = eventFromRow(eventRow);
    const runtime = getRuntimeForEvent(event, receivedAt);
    for (const rawSample of rawSamples) {
      const participant = runtime.participantByReceiver.get(Number(rawSample.receiverId));
      if (!participant) continue;
      const pilot = runtime.pilotsById.get(participant.pilotId);
      if (!pilot) continue;
      persistProcessedSample(event, pilot, participant, rawSample, runtime, receivedAt);
    }

    return maybeBuildServerLiveState(event, receivedAt);
  } catch (error) {
    serverLiveState.receiverState.error = error.message || "serial packet processing failed";
    return maybeBuildServerLiveState(null, Date.now(), true);
  }
}

function processQueuedSerialPackets() {
  const entries = [...pendingSerialPackets.entries()];
  pendingSerialPackets.clear();
  for (const [roomId, queued] of entries) {
    const serverState = processServerSerialPacket(queued.packet, {
      roomId,
      receivedAt: queued.receivedAt,
    });
    if (serverState) broadcastLiveState(roomId, serverState);
  }
}

function processQueuedTrainingCsvPackets() {
  const queuedPackets = pendingTrainingCsvPackets.splice(0, pendingTrainingCsvPackets.length);
  if (!queuedPackets.length) return;
  const eventRow = activeEventQuery.get();
  if (!eventRow) return;
  const event = eventFromRow(eventRow);
  const runtime = getCsvRuntimeForEvent(event, Date.now());

  for (const queued of queuedPackets) {
    const rawSamples = parseSerialPacket(queued.packet, queued.receivedAt);
    for (const rawSample of rawSamples) {
      const participant = runtime.participantByReceiver.get(Number(rawSample.receiverId));
      if (!participant) continue;
      const pilot = runtime.pilotsById.get(participant.pilotId);
      if (!pilot) continue;
      processTrainingCsvSample(event, pilot, participant, rawSample, runtime, queued.receivedAt);
    }
  }
}

function clipSegmentToWindow(segment, start, end) {
  const segmentStart = Math.max(start, Number(segment.started_at || 0));
  const segmentEnd = Math.min(end, Number(segment.ended_at || 0));
  if (segmentEnd <= segmentStart) return null;
  return {
    type: segment.type,
    startedAt: segmentStart,
    endedAt: segmentEnd,
    durationMs: segmentEnd - segmentStart,
  };
}

function summarizeCoachWindow(segments, start, end) {
  const durationMs = Math.max(1, end - start);
  const clipped = segments
    .map((segment) => clipSegmentToWindow(segment, start, end))
    .filter(Boolean);
  const flightSegments = clipped.filter((segment) => segment.type === "flight");
  const turtleSegments = clipped.filter((segment) => segment.type === "turtle");
  const idleSegments = clipped.filter((segment) => segment.type === "idle");
  const totalFlightMs = flightSegments.reduce((total, segment) => total + segment.durationMs, 0);
  const totalTurtleMs = turtleSegments.reduce((total, segment) => total + segment.durationMs, 0);
  const totalIdleMs = idleSegments.reduce((total, segment) => total + segment.durationMs, 0);
  const lastFlightEnd = flightSegments.reduce((latest, segment) => Math.max(latest, segment.endedAt), 0);
  const activeMs = totalFlightMs + totalTurtleMs;
  return {
    start,
    end,
    durationMs,
    segmentCount: clipped.length,
    flightCount: flightSegments.length,
    turtleCount: turtleSegments.length,
    idleCount: idleSegments.length,
    totalFlightMs,
    totalTurtleMs,
    totalIdleMs,
    activeMs,
    utilization: totalFlightMs / durationMs,
    avgIdleMs: idleSegments.length ? totalIdleMs / idleSegments.length : totalFlightMs > 0 ? 0 : durationMs,
    flightTimePer10MinMs: totalFlightMs / Math.max(1, durationMs / (10 * 60 * 1000)),
    avgFlightDurationMs: flightSegments.length ? totalFlightMs / flightSegments.length : 0,
    turtleTimeRatio: totalTurtleMs / Math.max(1, activeMs),
    interruptionRatio: totalIdleMs / durationMs,
    lastFlightEnd: lastFlightEnd || null,
  };
}

function coachWindowScore(summary) {
  const utilizationScore = Math.min(1, summary.utilization / 0.45);
  const flightTimeScore = Math.min(1, summary.flightTimePer10MinMs / (4 * 60 * 1000));
  const activeScore = Math.min(1, summary.totalFlightMs / (5 * 60 * 1000));
  const idlePenalty = Math.min(1, summary.avgIdleMs / (6 * 60 * 1000));
  const turtlePenalty = Math.min(1, summary.turtleTimeRatio * 2);
  return (
    utilizationScore * 0.28 +
    flightTimeScore * 0.22 +
    activeScore * 0.18 -
    idlePenalty * 0.12 -
    turtlePenalty * 0.16
  );
}

function trendFromDelta(delta, deadband = 0.08) {
  if (delta > deadband) return "improving";
  if (delta < -deadband) return "degrading";
  return "stable";
}

function buildCoachReasons(features, recent, idleSinceLastFlightMs) {
  const reasons = [];
  if (idleSinceLastFlightMs >= 6 * 60 * 1000) reasons.push({ code: "long_idle", label: "距离上次飞行时间偏长" });
  if (features.totalFlightMs > 0 && features.totalFlightMs < 60 * 1000) reasons.push({ code: "low_flight_time", label: "最近飞行时间偏少" });
  if (features.totalTurtleMs >= 30 * 1000 && features.turtleTimeRatio >= 0.2) reasons.push({ code: "turtle_time_high", label: "反乌龟时间占比偏高" });
  if (features.utilization >= 0.35 && features.turtleTimeRatio < 0.15) reasons.push({ code: "pace_stable", label: "飞行时间和反乌龟时间保持正常" });
  return reasons;
}

function decideCoachState({ features, recent, trend, idleSinceLastFlightMs }) {
  if (recent.totalFlightMs <= 0 && idleSinceLastFlightMs >= 6 * 60 * 1000) return "inactive";
  if (trend.overall === "improving" && recent.totalFlightMs > 0) return "improving";
  if (
    (features.totalTurtleMs >= 30 * 1000 && features.turtleTimeRatio >= 0.2) ||
    (features.totalFlightMs > 0 && features.totalFlightMs < 60 * 1000 && idleSinceLastFlightMs >= 2 * 60 * 1000)
  ) {
    return "unstable";
  }
  return "stable";
}

function suggestionForCoachState(state, pilotName, reasons) {
  if (state === "inactive") return `${pilotName} 已经一段时间没有有效飞行，可以提醒他准备下一轮。`;
  if (state === "improving") return `${pilotName} 最近节奏在变好，保持当前强度，不要急着加难度。`;
  if (state === "unstable") {
    const hasTurtle = reasons.some((reason) => reason.code === "turtle_time_high");
    if (hasTurtle) return `${pilotName} 反乌龟偏多，建议先降低强度，做一轮稳定飞行。`;
    return `${pilotName} 最近有效飞行时间偏少，建议先完成一轮稳定飞行。`;
  }
  return `${pilotName} 当前状态稳定，继续观察即可。`;
}

function getCoachLlmConfig({ includeSecret = false } = {}) {
  const row = db.prepare("SELECT value_json FROM training_settings WHERE key = ?").get(COACH_LLM_CONFIG_KEY);
  const stored = safeJsonParse(row?.value_json, {});
  const config = {
    ...DEFAULT_COACH_LLM_CONFIG,
    ...(stored && typeof stored === "object" ? stored : {}),
  };
  config.enabled = Boolean(config.enabled);
  config.endpoint = String(config.endpoint || DEFAULT_COACH_LLM_CONFIG.endpoint).slice(0, 500);
  config.model = String(config.model || DEFAULT_COACH_LLM_CONFIG.model).slice(0, 120);
  config.apiKey = String(config.apiKey || "");
  config.systemPrompt = String(config.systemPrompt || DEFAULT_COACH_LLM_CONFIG.systemPrompt).slice(0, 4000);
  config.temperature = Math.max(0, Math.min(1, Number(config.temperature ?? 0.2)));
  config.timeoutMs = Math.max(3000, Math.min(30000, Number(config.timeoutMs || 12000)));
  config.autoIntervalMinutes = Math.max(1, Math.min(60, Number(config.autoIntervalMinutes || 5)));
  if (includeSecret) return config;
  return {
    ...config,
    apiKey: "",
    hasApiKey: Boolean(config.apiKey),
    lastError: coachLlmRuntime.lastError,
  };
}

function saveCoachLlmConfig(input) {
  const current = getCoachLlmConfig({ includeSecret: true });
  const next = {
    ...current,
    enabled: Boolean(input?.enabled),
    endpoint: String(input?.endpoint || current.endpoint).trim().slice(0, 500),
    model: String(input?.model || current.model).trim().slice(0, 120),
    apiKey: input?.apiKey === undefined ? current.apiKey : String(input.apiKey || "").trim(),
    systemPrompt: String(input?.systemPrompt || current.systemPrompt).slice(0, 4000),
    temperature: Math.max(0, Math.min(1, Number(input?.temperature ?? current.temperature))),
    timeoutMs: Math.max(3000, Math.min(30000, Number(input?.timeoutMs || current.timeoutMs))),
    autoIntervalMinutes: Math.max(1, Math.min(60, Number(input?.autoIntervalMinutes || current.autoIntervalMinutes || 5))),
  };
  db.prepare(`
    INSERT INTO training_settings (key, value_json)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
  `).run(COACH_LLM_CONFIG_KEY, JSON.stringify(next));
  coachLlmRuntime.signatures.clear();
  coachLlmRuntime.autoCursor = 0;
  coachLlmRuntime.lastError = "";
  return getCoachLlmConfig();
}

function coachLlmSuggestionSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["message", "priority", "speakable", "reason"],
    properties: {
      message: { type: "string", minLength: 1, maxLength: 80 },
      priority: { type: "string", enum: ["low", "medium", "high"] },
      speakable: { type: "boolean" },
      reason: { type: "string", minLength: 1, maxLength: 80 },
    },
  };
}

function coachEventSummarySchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["overallEvaluation", "atmosphere", "strongPilots", "attentionPilots", "nextRoundAdvice", "speakableSummary"],
    properties: {
      overallEvaluation: { type: "string", minLength: 1, maxLength: 160 },
      atmosphere: { type: "string", minLength: 1, maxLength: 120 },
      strongPilots: {
        type: "array",
        maxItems: 4,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["pilotName", "reason"],
          properties: {
            pilotName: { type: "string", minLength: 1, maxLength: 40 },
            reason: { type: "string", minLength: 1, maxLength: 80 },
          },
        },
      },
      attentionPilots: {
        type: "array",
        maxItems: 4,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["pilotName", "reason"],
          properties: {
            pilotName: { type: "string", minLength: 1, maxLength: 40 },
            reason: { type: "string", minLength: 1, maxLength: 80 },
          },
        },
      },
      nextRoundAdvice: { type: "array", minItems: 1, maxItems: 5, items: { type: "string", minLength: 1, maxLength: 80 } },
      speakableSummary: { type: "string", minLength: 1, maxLength: 100 },
    },
  };
}

function sanitizeCoachLlmSuggestion(value) {
  if (!value || typeof value !== "object") return null;
  const priority = ["low", "medium", "high"].includes(value.priority) ? value.priority : "low";
  const message = String(value.message || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const reason = String(value.reason || "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!message || !reason) return null;
  return {
    message,
    priority,
    speakable: Boolean(value.speakable),
    reason,
  };
}

function sanitizeCoachEventSummary(value) {
  if (!value || typeof value !== "object") return null;
  const text = (input, max = 120) => String(input || "").replace(/\s+/g, " ").trim().slice(0, max);
  const pilotList = (items) => (Array.isArray(items) ? items : [])
    .map((item) => ({ pilotName: text(item?.pilotName, 40), reason: text(item?.reason, 80) }))
    .filter((item) => item.pilotName && item.reason)
    .slice(0, 4);
  const nextRoundAdvice = (Array.isArray(value.nextRoundAdvice) ? value.nextRoundAdvice : [])
    .map((item) => text(item, 80))
    .filter(Boolean)
    .slice(0, 5);
  const summary = {
    overallEvaluation: text(value.overallEvaluation, 160),
    atmosphere: text(value.atmosphere, 120),
    strongPilots: pilotList(value.strongPilots),
    attentionPilots: pilotList(value.attentionPilots),
    nextRoundAdvice,
    speakableSummary: text(value.speakableSummary, 100),
  };
  if (!summary.overallEvaluation || !summary.atmosphere || !summary.speakableSummary || summary.nextRoundAdvice.length === 0) return null;
  return summary;
}

function parseCoachLlmJson(text) {
  if (typeof text !== "string") return text;
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const parsed = safeJsonParse(trimmed, null);
  if (parsed) return parsed;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return safeJsonParse(trimmed.slice(start, end + 1), null);
  return null;
}

function coachLlmSignature(pilotSnapshot) {
  const features = pilotSnapshot.features || {};
  return JSON.stringify({
    state: pilotSnapshot.coachState,
    reasons: (pilotSnapshot.reasons || []).map((reason) => reason.code).sort(),
    trends: pilotSnapshot.trends || {},
    totalFlightMinute: Math.round(Number(features.totalFlightMs || 0) / 60000),
    totalTurtleSecond: Math.round(Number(features.totalTurtleMs || 0) / 10000) * 10,
    idleMinute: Math.round(Number(features.idleSinceLastFlightMs || 0) / 60000),
    turtleRatioPct: Math.round(Number(features.turtleTimeRatio || 0) * 100),
  });
}

function coachLlmPromptPayload(event, pilotSnapshot) {
  return {
    event: event ? { id: event.id, name: event.name, active: event.active, startedAt: event.startedAt } : null,
    pilot: {
      pilotId: pilotSnapshot.pilotId,
      pilotName: pilotSnapshot.pilotName,
      receiverId: pilotSnapshot.receiverId,
      coachState: pilotSnapshot.coachState,
      reasons: pilotSnapshot.reasons,
      trends: pilotSnapshot.trends,
      features: pilotSnapshot.features,
      ruleSuggestion: pilotSnapshot.suggestion,
    },
    outputContract: {
      message: "一句现场助教建议，适合直接展示或播报",
      priority: "low | medium | high",
      speakable: "是否适合人工点击后 TTS 播放",
      reason: "一句短原因",
    },
  };
}

function coachLlmRequestBody(config, event, pilotSnapshot, responseFormatType) {
  const schema = coachLlmSuggestionSchema();
  const body = {
    model: config.model,
    temperature: config.temperature,
    messages: [
      { role: "system", content: config.systemPrompt },
      {
        role: "user",
        content: JSON.stringify({
          coachSnapshot: coachLlmPromptPayload(event, pilotSnapshot),
          requiredJsonSchema: schema,
          instruction: "只返回一个 JSON 对象，不要 Markdown，不要多余文字。",
        }),
      },
    ],
  };
  if (responseFormatType === "json_schema") {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: "coach_suggested_message",
        strict: true,
        schema,
      },
    };
  } else if (responseFormatType === "json_object") {
    body.response_format = { type: "json_object" };
  }
  return body;
}

async function requestCoachLlmSuggestionWithFormat(config, event, pilotSnapshot, responseFormatType) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(coachLlmRequestBody(config, event, pilotSnapshot, responseFormatType)),
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`LLM HTTP ${response.status}: ${body.slice(0, 200)}`);
    const parsedBody = safeJsonParse(body, null);
    const content = parsedBody?.choices?.[0]?.message?.content;
    const parsedContent = parseCoachLlmJson(content);
    const suggestion = sanitizeCoachLlmSuggestion(parsedContent);
    if (!suggestion) throw new Error("LLM returned invalid suggestion JSON");
    return suggestion;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestCoachLlmSuggestion(config, event, pilotSnapshot) {
  const formats = ["json_schema", "json_object", null];
  let lastError = null;
  for (const format of formats) {
    try {
      return await requestCoachLlmSuggestionWithFormat(config, event, pilotSnapshot, format);
    } catch (error) {
      lastError = error;
      const message = String(error?.message || "");
      if (!/response_format|unavailable|invalid_request|HTTP 400/i.test(message)) break;
    }
  }
  throw lastError || new Error("coach LLM request failed");
}

function coachEventSummaryPayload(event, pilotSnapshots, now = Date.now()) {
  const eventStart = optionalTimestamp(event?.startedAt) || optionalTimestamp(event?.createdAt) || now;
  const eventEnd = event?.active ? now : optionalTimestamp(event?.endedAt) || now;
  const durationMs = Math.max(1, eventEnd - eventStart);
  const totalFlightMs = pilotSnapshots.reduce((total, pilot) => total + Number(pilot.features?.totalFlightMs || 0), 0);
  const totalTurtleMs = pilotSnapshots.reduce((total, pilot) => total + Number(pilot.features?.totalTurtleMs || 0), 0);
  const states = pilotSnapshots.reduce((acc, pilot) => {
    acc[pilot.coachState] = (acc[pilot.coachState] || 0) + 1;
    return acc;
  }, {});
  const problemFlags = [];
  if (totalFlightMs / Math.max(1, durationMs * Math.max(1, pilotSnapshots.length)) < 0.2) problemFlags.push("节奏慢");
  if (totalTurtleMs / Math.max(1, totalFlightMs + totalTurtleMs) >= 0.2) problemFlags.push("反乌龟偏多");
  if ((states.improving || 0) > 0) problemFlags.push("有进步");
  if ((states.unstable || 0) === 0 && (states.inactive || 0) === 0) problemFlags.push("整体稳定");
  return {
    event: {
      id: event.id,
      name: event.name,
      startedAt: event.startedAt,
      durationMs,
      participantCount: pilotSnapshots.length,
      totalFlightMs,
      totalTurtleMs,
      overallUtilization: totalFlightMs / Math.max(1, durationMs * Math.max(1, pilotSnapshots.length)),
      problemFlags,
    },
    pilots: pilotSnapshots.map((pilot) => ({
      pilotId: pilot.pilotId,
      pilotName: pilot.pilotName,
      receiverId: pilot.receiverId,
      state: pilot.coachState,
      reasons: pilot.reasons,
      trends: pilot.trends,
      flightMs: pilot.features?.totalFlightMs || 0,
      utilization: pilot.features?.utilization || 0,
      avgIdleMs: pilot.features?.avgIdleMs || 0,
      turtleMs: pilot.features?.totalTurtleMs || 0,
      turtleTimeRatio: pilot.features?.turtleTimeRatio || 0,
    })),
    outputContract: {
      overallEvaluation: "本场整体评价",
      atmosphere: "训练氛围判断",
      strongPilots: "表现较好的飞手列表",
      attentionPilots: "需要关注的飞手列表",
      nextRoundAdvice: "下一轮训练建议数组",
      speakableSummary: "一句话播报总结",
    },
  };
}

async function requestCoachEventSummary(config, event, pilotSnapshots, now = Date.now()) {
  const schema = coachEventSummarySchema();
  const promptPayload = {
    coachEventSummaryInput: coachEventSummaryPayload(event, pilotSnapshots, now),
    requiredJsonSchema: schema,
    instruction: "只返回一个 JSON 对象，不要 Markdown，不要多余文字。",
  };
  const formats = ["json_schema", "json_object", null];
  let lastError = null;
  for (const responseFormatType of formats) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const body = {
        model: config.model,
        temperature: config.temperature,
        messages: [
          { role: "system", content: `${config.systemPrompt}\n你现在要生成整场训练总结，不是单个飞手建议。` },
          { role: "user", content: JSON.stringify(promptPayload) },
        ],
      };
      if (responseFormatType === "json_schema") {
        body.response_format = {
          type: "json_schema",
          json_schema: { name: "coach_event_summary", strict: true, schema },
        };
      } else if (responseFormatType === "json_object") {
        body.response_format = { type: "json_object" };
      }
      const response = await fetch(config.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const responseText = await response.text();
      if (!response.ok) throw new Error(`LLM HTTP ${response.status}: ${responseText.slice(0, 200)}`);
      const parsedBody = safeJsonParse(responseText, null);
      const parsedContent = parseCoachLlmJson(parsedBody?.choices?.[0]?.message?.content);
      const summary = sanitizeCoachEventSummary(parsedContent);
      if (!summary) throw new Error("LLM returned invalid event summary JSON");
      return summary;
    } catch (error) {
      lastError = error;
      const message = String(error?.message || "");
      if (!/response_format|unavailable|invalid_request|HTTP 400/i.test(message)) break;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error("coach event summary failed");
}

function attachCoachLlmSuggestions(event, pilotSnapshots) {
  return pilotSnapshots.map((pilotSnapshot) => {
    const key = `${event?.id || ""}:${pilotSnapshot.pilotId}:${pilotSnapshot.receiverId}`;
    return {
      ...pilotSnapshot,
      suggestedMessage: coachLlmRuntime.suggestions.get(key) || null,
    };
  });
}

function queueCoachLlmSuggestions(event, pilotSnapshots) {
  const config = getCoachLlmConfig({ includeSecret: true });
  if (!config.enabled || !config.apiKey || !config.endpoint || !config.model) return;
  if (coachLlmRuntime.inFlight.size > 0) return;
  const now = Date.now();
  const minIntervalMs = Math.max(1, Number(config.autoIntervalMinutes || 5)) * 60 * 1000;
  const candidates = pilotSnapshots.map((pilotSnapshot, index) => ({
    index,
    pilotSnapshot,
    key: `${event.id}:${pilotSnapshot.pilotId}:${pilotSnapshot.receiverId}`,
    signature: coachLlmSignature(pilotSnapshot),
  }));
  const startIndex = candidates.length ? coachLlmRuntime.autoCursor % candidates.length : 0;
  const orderedCandidates = [...candidates.slice(startIndex), ...candidates.slice(0, startIndex)];

  for (const { index, pilotSnapshot, key, signature } of orderedCandidates) {
    if (coachLlmRuntime.signatures.get(key) === signature || coachLlmRuntime.inFlight.has(key)) continue;
    if (now - (coachLlmRuntime.autoRequestedAt.get(key) || 0) < minIntervalMs) continue;
    coachLlmRuntime.autoCursor = index + 1;
    coachLlmRuntime.signatures.set(key, signature);
    coachLlmRuntime.autoRequestedAt.set(key, now);
    coachLlmRuntime.inFlight.add(key);
    void requestCoachLlmSuggestion(config, event, pilotSnapshot)
      .then((suggestion) => {
        coachLlmRuntime.suggestions.set(key, {
          ...suggestion,
          generatedAt: Date.now(),
          eventId: event.id,
          pilotId: pilotSnapshot.pilotId,
          pilotName: pilotSnapshot.pilotName,
          receiverId: pilotSnapshot.receiverId,
          signature,
        });
        coachLlmRuntime.lastError = "";
      })
      .catch((error) => {
        coachLlmRuntime.lastError = error.message || "coach LLM request failed";
        coachLlmRuntime.signatures.delete(key);
      })
      .finally(() => {
        coachLlmRuntime.inFlight.delete(key);
      });
    break;
  }
}

function buildCoachPilotSnapshot({ event, participant, pilot, stat, segments, now }) {
  const trainingWindow = getParticipantTrainingWindow(event, participant, now);
  const end = event.active ? now : trainingWindow.end;
  const start = trainingWindow.start;
  const recentStart = Math.max(start, end - COACH_WINDOW_MS);
  const previousStart = Math.max(start, recentStart - COACH_WINDOW_MS);
  const previousEnd = recentStart;
  const session = summarizeCoachWindow(segments, start, end);
  const recent = summarizeCoachWindow(segments, recentStart, end);
  const previous = previousEnd > previousStart
    ? summarizeCoachWindow(segments, previousStart, previousEnd)
    : summarizeCoachWindow([], previousStart, previousEnd);
  const recentScore = coachWindowScore(recent);
  const previousScore = coachWindowScore(previous);
  const idleSinceLastFlightMs = session.lastFlightEnd ? Math.max(0, end - session.lastFlightEnd) : Math.max(0, end - start);
  const features = {
    utilization: stat ? Number(stat.total_flight_ms || 0) / Math.max(1, end - start) : session.utilization,
    avgIdleMs: recent.avgIdleMs,
    flightTimePer10MinMs: recent.flightTimePer10MinMs,
    avgFlightDurationMs: recent.avgFlightDurationMs,
    totalFlightMs: recent.totalFlightMs,
    totalTurtleMs: recent.totalTurtleMs,
    turtleTimeRatio: recent.turtleTimeRatio,
    interruptionRatio: recent.interruptionRatio,
    idleSinceLastFlightMs,
  };
  const trends = {
    utilization: trendFromDelta(recent.utilization - previous.utilization, 0.05),
    stability: trendFromDelta(previous.turtleTimeRatio - recent.turtleTimeRatio, 0.08),
    overall: trendFromDelta(recentScore - previousScore),
  };
  const coachState = decideCoachState({ features, recent, trend: trends, idleSinceLastFlightMs });
  const reasons = buildCoachReasons(features, recent, idleSinceLastFlightMs);

  return {
    pilotId: participant.pilotId,
    pilotName: pilot?.name || participant.pilotId,
    receiverId: participant.receiverId,
    window: { start, end, recentStart, previousStart, previousEnd },
    features,
    trends,
    coachState,
    reasons,
    suggestion: suggestionForCoachState(coachState, pilot?.name || participant.pilotId, reasons),
    debug: {
      sessionSegments: session.segmentCount,
      recentSegments: recent.segmentCount,
      previousSegments: previous.segmentCount,
      recentScore,
      previousScore,
    },
  };
}

function refreshCoachSnapshot(now = Date.now()) {
  try {
    const eventRow = activeEventQuery.get();
    if (!eventRow) {
      coachSnapshotStore.activeEventId = null;
      coachSnapshotStore.generatedAt = now;
      coachSnapshotStore.stale = false;
      coachSnapshotStore.event = null;
      coachSnapshotStore.pilots = [];
      coachSnapshotStore.eventSummary = null;
      coachSnapshotStore.error = "";
      return coachSnapshotStore;
    }

    const event = eventFromRow(eventRow);
    const overview = readCachedEventOverview(event.id);
    const pilotsById = new Map(allPilotsQuery.all().map((row) => {
      const pilot = pilotFromRow(row);
      return [pilot.id, pilot];
    }));
    const statsByPilot = new Map((overview.stats || []).map((stat) => [stat.pilot_id, stat]));
    const segmentsByPilot = new Map();
    for (const segment of overview.segments || []) {
      const list = segmentsByPilot.get(segment.pilot_id) || [];
      list.push(segment);
      segmentsByPilot.set(segment.pilot_id, list);
    }

    const pilotSnapshots = (event.participants || []).map((participant) => buildCoachPilotSnapshot({
      event,
      participant,
      pilot: pilotsById.get(participant.pilotId),
      stat: statsByPilot.get(participant.pilotId),
      segments: segmentsByPilot.get(participant.pilotId) || [],
      now,
    }));
    queueCoachLlmSuggestions(event, pilotSnapshots);

    coachSnapshotStore.activeEventId = event.id;
    coachSnapshotStore.generatedAt = now;
    coachSnapshotStore.stale = false;
    coachSnapshotStore.event = event;
    coachSnapshotStore.pilots = attachCoachLlmSuggestions(event, pilotSnapshots);
    coachSnapshotStore.eventSummary = coachLlmRuntime.eventSummary?.eventId === event.id ? coachLlmRuntime.eventSummary : null;
    coachSnapshotStore.error = "";
    return coachSnapshotStore;
  } catch (error) {
    coachSnapshotStore.generatedAt = now;
    coachSnapshotStore.stale = true;
    coachSnapshotStore.error = error.message || "coach snapshot failed";
    return coachSnapshotStore;
  }
}

function getCoachSnapshot(now = Date.now()) {
  return {
    ...coachSnapshotStore,
    stale: Boolean(coachSnapshotStore.stale || !coachSnapshotStore.generatedAt || now - coachSnapshotStore.generatedAt > COACH_STALE_AFTER_MS),
    serverTime: now,
    refreshIntervalMs: COACH_SNAPSHOT_INTERVAL_MS,
    windowMs: COACH_WINDOW_MS,
  };
}

app.get("/api/coach/overview", (req, res) => {
  res.json(getCoachSnapshot());
});

app.get("/api/coach/llm-config", (req, res) => {
  res.json(getCoachLlmConfig());
});

app.post("/api/coach/llm-config", (req, res) => {
  res.json(saveCoachLlmConfig(req.body || {}));
});

app.post("/api/coach/llm-suggestions/:pilotId", async (req, res) => {
  try {
    const config = getCoachLlmConfig({ includeSecret: true });
    if (!config.apiKey) return res.status(400).json({ error: "LLM API key is required" });
    const eventRow = activeEventQuery.get();
    if (!eventRow) return res.status(404).json({ error: "active event not found" });

    const now = Date.now();
    const event = eventFromRow(eventRow);
    const participant = (event.participants || []).find((item) => item.pilotId === req.params.pilotId);
    if (!participant) return res.status(404).json({ error: "pilot not found in active event" });

    const overview = readCachedEventOverview(event.id);
    const pilotRow = db.prepare("SELECT * FROM pilots WHERE id = ?").get(participant.pilotId);
    const pilot = pilotRow ? pilotFromRow(pilotRow) : null;
    const stat = (overview.stats || []).find((item) => item.pilot_id === participant.pilotId) || null;
    const segments = (overview.segments || []).filter((item) => item.pilot_id === participant.pilotId);
    const pilotSnapshot = buildCoachPilotSnapshot({ event, participant, pilot, stat, segments, now });
    const suggestion = await requestCoachLlmSuggestion(config, event, pilotSnapshot);
    const signature = coachLlmSignature(pilotSnapshot);
    const key = `${event.id}:${pilotSnapshot.pilotId}:${pilotSnapshot.receiverId}`;
    const stored = {
      ...suggestion,
      generatedAt: Date.now(),
      eventId: event.id,
      pilotId: pilotSnapshot.pilotId,
      pilotName: pilotSnapshot.pilotName,
      receiverId: pilotSnapshot.receiverId,
      signature,
    };
    coachLlmRuntime.suggestions.set(key, stored);
    coachLlmRuntime.signatures.set(key, signature);
    coachLlmRuntime.lastError = "";
    refreshCoachSnapshot();
    res.json({ ok: true, suggestion: stored });
  } catch (error) {
    coachLlmRuntime.lastError = error.message || "coach LLM request failed";
    res.status(500).json({ error: coachLlmRuntime.lastError });
  }
});

app.post("/api/coach/event-summary", async (req, res) => {
  try {
    const config = getCoachLlmConfig({ includeSecret: true });
    if (!config.apiKey) return res.status(400).json({ error: "LLM API key is required" });
    const eventRow = activeEventQuery.get();
    if (!eventRow) return res.status(404).json({ error: "active event not found" });

    const now = Date.now();
    const event = eventFromRow(eventRow);
    const overview = readCachedEventOverview(event.id);
    const pilotsById = new Map(allPilotsQuery.all().map((row) => {
      const pilot = pilotFromRow(row);
      return [pilot.id, pilot];
    }));
    const statsByPilot = new Map((overview.stats || []).map((stat) => [stat.pilot_id, stat]));
    const segmentsByPilot = new Map();
    for (const segment of overview.segments || []) {
      const list = segmentsByPilot.get(segment.pilot_id) || [];
      list.push(segment);
      segmentsByPilot.set(segment.pilot_id, list);
    }
    const pilotSnapshots = (event.participants || []).map((participant) => buildCoachPilotSnapshot({
      event,
      participant,
      pilot: pilotsById.get(participant.pilotId),
      stat: statsByPilot.get(participant.pilotId),
      segments: segmentsByPilot.get(participant.pilotId) || [],
      now,
    }));
    const summary = await requestCoachEventSummary(config, event, pilotSnapshots, now);
    const stored = {
      ...summary,
      eventId: event.id,
      eventName: event.name,
      generatedAt: Date.now(),
    };
    coachLlmRuntime.eventSummary = stored;
    coachLlmRuntime.lastError = "";
    refreshCoachSnapshot();
    res.json({ ok: true, summary: stored });
  } catch (error) {
    coachLlmRuntime.lastError = error.message || "coach event summary failed";
    res.status(500).json({ error: coachLlmRuntime.lastError });
  }
});

app.post("/api/training-events/:id/stats", (req, res) => {
  const stats = Array.isArray(req.body?.stats) ? req.body.stats : [];
  const segments = Array.isArray(req.body?.segments) ? req.body.segments : [];
  const now = Date.now();
  runTransaction(() => {
    for (const stat of stats) {
      upsertStat.run(
        req.params.id,
        stat.pilotId,
        Math.round(stat.totalFlightMs || 0),
        Number(stat.utilization || 0),
        stat.idleMs ?? null,
        Math.round(stat.totalTurtleMs || 0),
        now,
      );
    }
    db.prepare("DELETE FROM training_segments WHERE event_id = ?").run(req.params.id);
    const insertSegment = db.prepare(`
      INSERT INTO training_segments (event_id, pilot_id, type, started_at, ended_at, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const segment of segments) {
      insertSegment.run(req.params.id, segment.pilotId, segment.type, segment.startedAt, segment.endedAt, segment.durationMs);
    }
  });
  res.json({ ok: true });
});

app.get("/api/training-events/:id/stats", (req, res) => {
  const eventRow = db.prepare("SELECT * FROM training_events WHERE id = ?").get(req.params.id);
  if (!eventRow) return res.status(404).json({ error: "event not found" });
  const cachedOverview = readCachedEventOverview(req.params.id);
  if (req.query.recompute !== "1") {
    return res.json(cachedOverview);
  }
  const event = eventFromRow(eventRow);
  const overview = computeEventOverview(event, req.params.id);
  persistEventOverview(req.params.id, overview);
  res.json({ stats: overview.stats, segments: overview.segments });
});

function publishServerHeartbeat() {
  try {
    const now = Date.now();
    refreshReceiverState(now, true);
    const eventRow = activeEventQuery.get();
    const event = eventRow ? eventFromRow(eventRow) : null;
    const state = maybeBuildServerLiveState(event, now);
    if (state) broadcastLiveState("default", state);
  } catch (error) {
    serverLiveState.receiverState.error = error.message || "server heartbeat failed";
  }
}

ensureTrainingCsvFile();
refreshTrainingCsvFileSize();
refreshCoachSnapshot();

const liveHeartbeat = setInterval(publishServerHeartbeat, LIVE_STATE_BROADCAST_INTERVAL_MS);
liveHeartbeat.unref?.();

const liveBatchBroadcastTimer = setInterval(processQueuedLiveBatches, LIVE_BATCH_BROADCAST_INTERVAL_MS);
liveBatchBroadcastTimer.unref?.();

const serialPersistenceTimer = setInterval(processQueuedSerialPackets, SAMPLE_WRITE_INTERVAL_MS);
serialPersistenceTimer.unref?.();

const trainingCsvPacketTimer = setInterval(processQueuedTrainingCsvPackets, LIVE_BATCH_BROADCAST_INTERVAL_MS);
trainingCsvPacketTimer.unref?.();

const trainingCsvFlushTimer = setInterval(flushTrainingCsvQueue, 1000);
trainingCsvFlushTimer.unref?.();

const coachSnapshotTimer = setInterval(refreshCoachSnapshot, COACH_SNAPSHOT_INTERVAL_MS);
coachSnapshotTimer.unref?.();

server.on("close", () => {
  clearInterval(coachSnapshotTimer);
  clearInterval(trainingCsvPacketTimer);
  clearInterval(trainingCsvFlushTimer);
  processQueuedTrainingCsvPackets();
  flushTrainingCsvQueue();
});

app.use(express.static("dist"));

app.get(/.*/, (req, res) => {
  res.sendFile(path.resolve("dist/index.html"));
});

server.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
  console.log(`SQLite DB: ${dbFile}`);
});
