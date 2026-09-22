const DEFAULT_TRANSPORT_RULES = {
  single: { name: "\u5355\u95e8", qty: 4, people: 1, cart: 1, minutes: 10, difficulty: 2, enabled: true, note: "\u5c0f\u8f66\u642c\u8fd0\uff0c\u652f\u6301 4/5 \u4e2a\u30011/2 \u4eba\u5019\u9009" },
  sun: { name: "\u65e5\u5b57\u95e8", qty: 2, people: 1, cart: 0, minutes: 8, difficulty: 4, enabled: true, note: "\u652f\u6301 1/2 \u4eba\u5019\u9009" },
  gravity: { name: "\u91cd\u529b\u95e8", qty: 1, people: 1, cart: 0, minutes: 8, difficulty: 1, enabled: true, note: "\u81ea\u5e26\u8f6e\u5b50" },
  doubleGravity: { name: "\u53cc\u5c42\u91cd\u529b\u95e8", qty: 1, people: 2, cart: 0, minutes: 10, difficulty: 5, enabled: true, note: "\u56fa\u5b9a 2 \u4eba" },
  triple: { name: "\u4e09\u5c42\u95e8", qty: 1, people: 1, cart: 0, minutes: 15, difficulty: 3, enabled: true, note: "\u56fa\u5b9a 1 \u4eba\uff0c\u6709\u8f6e\u5b50" },
  flag: { name: "\u5200\u65d7", qty: 4, people: 1, cart: 0, minutes: 4, difficulty: 1, enabled: true, note: "\u8f7b\u91cf\u5668\u6750" },
};

function plannerNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function plannerClone(value) {
  return JSON.parse(JSON.stringify(value));
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

function calculateTransportPlans(input = {}) {
  return bbCalculateTransportPlans(input);
}

// 分支定界搬运规划器：后端负责真实搬运排程计算。

const BB_DEFAULT_TRANSPORT_RULES = DEFAULT_TRANSPORT_RULES;

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
        bbMakeAlt(`日字门${index}`, "sun", qty, people, Math.max(0, Math.floor(r.sun.cart)), r.sun.minutes * (people === 2 ? p.sunTwoPeopleCoef : 1), r.sun.difficulty)
      ));
      const id = `sun_${index}`;
      jobs.push(bbMakeJob(id, alts));
      sandNeeds.push({ dep: id, target: `日字门${index}`, count: qty * Math.max(0, Math.floor(p.sunSandPerGate)) });
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
  return `混用规则：单门 ${counts.single4} 趟×4个、${counts.single5} 趟×5个；单门 ${counts.single1} 趟1人、${counts.single2} 趟2人；日字门 ${counts.sun1} 趟1人、${counts.sun2} 趟2人；刀旗 ${counts.flag} 趟；沙包 手提${counts.sandHand}趟、小车${counts.sandCart}趟`;
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

export { DEFAULT_TRANSPORT_RULES, calculateTransportPlans };
