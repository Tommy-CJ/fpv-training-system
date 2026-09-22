import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function registerTeachingRoutes({
  activeEventQuery, allPilotsQuery, app, applyThinkingMode, buildCoachPilotSnapshot,
  coachLlmRuntime, coachLlmSignature, computeEventOverview, db, defaultLessonBudgetConfig,
  ensureEventTimelineCurrent, eventFromRow, getCoachLlmConfig, getEventTimelineStatus,
  getCoachSnapshot, getLessonTrackRow, historyEventSnapshots,
  lessonBudgetConfigKey, lessonExtraMaterialKey, lessonSystemPromptKey, lessonTeachingManualKey,
  getParticipantTrainingWindow, optionalTimestamp, parseAiJsonContent, persistEventOverview,
  personalLessonOptimizeLimit, pilotFromRow, qweatherGet, readCachedEventOverview,
  refreshCoachSnapshot, requestCoachEventSummary,
  requestCoachLlmSuggestion, requestHistoryClassSummary, requestHistoryStudentSummary,
  requireCoachPassword, runTransaction, safeJsonParse, saveCoachLlmConfig, settingJson,
  setSettingJson, trackFromRow, upsertStat, uploadsDir,
}) {
const LESSON_BUDGET_CONFIG_KEY = lessonBudgetConfigKey;
const LESSON_EXTRA_MATERIAL_KEY = lessonExtraMaterialKey;
const LESSON_SYSTEM_PROMPT_KEY = lessonSystemPromptKey;
const LESSON_TEACHING_MANUAL_KEY = lessonTeachingManualKey;
const PERSONAL_LESSON_OPTIMIZE_LIMIT = personalLessonOptimizeLimit;
const DEFAULT_LESSON_BUDGET_CONFIG = defaultLessonBudgetConfig;
const trainingMediaDir = path.join(uploadsDir, "training");
fs.mkdirSync(trainingMediaDir, { recursive: true });
function parseTeachingJson(text, fallback) {
  try {
    return JSON.parse(text || "");
  } catch {
    return fallback;
  }
}

function normalizeStarCriteria(value) {
  const rawItems = Array.isArray(value) ? value : [];
  return rawItems
    .map((item) => ({
      star: Math.max(1, Math.min(5, Math.floor(Number(item?.star || 0)))),
      criterion: String(item?.criterion || "").trim(),
    }))
    .filter((item) => item.star && item.criterion)
    .sort((left, right) => left.star - right.star);
}

function skillTreeRows() {
  const rows = db.prepare("SELECT * FROM skill_tree ORDER BY category, parent_id IS NOT NULL, sort_order, created_at").all();
  return rows.map((row) => ({
    ...row,
    star_criteria: parseTeachingJson(row.star_criteria, []),
  }));
}

function wouldCreateSkillCycle(id, parentId) {
  if (!id || !parentId) return false;
  if (id === parentId) return true;
  let currentId = parentId;
  const seen = new Set();
  while (currentId) {
    if (currentId === id) return true;
    if (seen.has(currentId)) return true;
    seen.add(currentId);
    const row = db.prepare("SELECT parent_id FROM skill_tree WHERE id = ?").get(currentId);
    currentId = row?.parent_id || null;
  }
  return false;
}

function clampTeachingScore(value, fallback = 3) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(5, number));
}

// Skill tree routes
app.get("/api/teaching/skill-tree", (req, res) => {
  res.json(skillTreeRows());
});

app.post("/api/teaching/skill-tree", requireCoachPassword, (req, res) => {
  const now = Date.now();
  const id = req.body?.id || `skill-${now}-${crypto.randomBytes(3).toString("hex")}`;
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "技能点名称不能为空" });
  const parentId = req.body?.parent_id || null;
  const parent = parentId ? db.prepare("SELECT id, name, category FROM skill_tree WHERE id = ?").get(parentId) : null;
  if (parentId && !parent) return res.status(400).json({ error: "\u7236\u7ea7\u6280\u80fd\u70b9\u4e0d\u5b58\u5728" });
  if (wouldCreateSkillCycle(id, parentId)) return res.status(400).json({ error: "不能把技能点移动到自身或子节点下" });
  const category = String(req.body?.category || parent?.category || parent?.name || name).trim();
  const starCriteria = normalizeStarCriteria(req.body?.star_criteria);
  db.prepare(`INSERT INTO skill_tree (id, parent_id, name, category, description, star_criteria, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      parent_id = excluded.parent_id,
      name = excluded.name,
      category = excluded.category,
      description = excluded.description,
      star_criteria = excluded.star_criteria,
      sort_order = excluded.sort_order,
      updated_at = excluded.updated_at
  `).run(
    id,
    parentId,
    name,
    category,
    String(req.body?.description || ""),
    JSON.stringify(starCriteria),
    Number(req.body?.sort_order || 0),
    now,
    now,
  );
  res.json({ id, name, updated_at: now });
});

app.delete("/api/teaching/skill-tree/:id", requireCoachPassword, (req, res) => {
  const exists = db.prepare("SELECT id FROM skill_tree WHERE id = ?").get(req.params.id);
  if (!exists) return res.status(404).json({ error: "\u6280\u80fd\u70b9\u4e0d\u5b58\u5728" });
  const idsToDelete = [req.params.id];
  const collectedIds = [];
  while (idsToDelete.length) {
    const currentId = idsToDelete.shift();
    collectedIds.push(currentId);
    const children = db.prepare("SELECT id FROM skill_tree WHERE parent_id = ?").all(currentId);
    idsToDelete.push(...children.map((child) => child.id));
  }
  runTransaction(() => {
    for (const skillId of collectedIds) {
      db.prepare("DELETE FROM pilot_skill_progress WHERE skill_id = ?").run(skillId);
      db.prepare("DELETE FROM skill_tree WHERE id = ?").run(skillId);
    }
  });
  res.json({ deleted: true, deletedIds: collectedIds });
});

app.post("/api/teaching/skill-tree/import", requireCoachPassword, (req, res) => {
  const data = req.body;
  // Expected payload: { skills: [...] } or legacy { categories: [...] }.
  const nodes = Array.isArray(data.skills) ? data.skills : (Array.isArray(data.categories) ? data.categories : null);
  if (!nodes) {
    return res.status(400).json({ error: "\u683c\u5f0f\u9519\u8bef\uff0c\u9700\u8981 { skills: [...] } \u6216 { categories: [...] }" });
  }
  const now = Date.now();
  const insert = db.prepare(`INSERT INTO skill_tree (id, parent_id, name, category, description, star_criteria, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  function insertTree(items, parentId, inheritedCategory) {
    if (!Array.isArray(items)) return;
    items.forEach((item, index) => {
      const name = String(item?.name || "").trim();
      if (!name) throw new Error("技能点名称不能为空");
      const id = item.id || `skill-${now}-${crypto.randomBytes(4).toString("hex")}`;
      const category = String(item.category || inheritedCategory || name).trim();
      insert.run(
        id,
        parentId || null,
        name,
        category,
        item.description || "",
        JSON.stringify(normalizeStarCriteria(item.star_criteria)),
        index,
        now,
        now,
      );
      if (Array.isArray(item.children)) {
        insertTree(item.children, id, category);
      }
      if (Array.isArray(item.skills)) {
        insertTree(item.skills, id, category);
      }
    });
  }

  try {
    runTransaction(() => {
      db.prepare("DELETE FROM pilot_skill_progress").run();
      db.prepare("DELETE FROM skill_tree").run();
      insertTree(nodes, null, "");
    });
    res.json(skillTreeRows());
  } catch (error) {
    res.status(400).json({ error: error.message || "\u5bfc\u5165\u5931\u8d25" });
  }
});

// Pilot profile routes
app.get("/api/teaching/pilot/:id/skills", (req, res) => {
  const skillRows = db.prepare("SELECT * FROM skill_tree ORDER BY category, parent_id IS NOT NULL, sort_order, created_at").all();
  const progressRows = db.prepare("SELECT * FROM pilot_skill_progress WHERE pilot_id = ?").all(req.params.id);
  const progressMap = new Map(progressRows.map((row) => [row.skill_id, row]));
  res.json(skillRows.map((skill) => {
    const progress = progressMap.get(skill.id);
    return {
      skill_id: skill.id,
      name: skill.name,
      category: skill.category,
      parent_id: skill.parent_id,
      star_criteria: parseTeachingJson(skill.star_criteria, []),
      current_stars: progress?.current_stars || 0,
      evidence: progress ? parseTeachingJson(progress.evidence_json, []) : [],
    };
  }));
});

app.get("/api/teaching/pilot/:id/growth", (req, res) => {
  const rows = db.prepare(
    "SELECT * FROM pilot_growth_log WHERE pilot_id = ? ORDER BY occurred_at DESC LIMIT 50"
  ).all(req.params.id);
  res.json(rows.map((row) => {
    const metadata = parseTeachingJson(row.metadata_json, {});
    if (row.type === "star" && metadata.skillId && metadata.starTo) {
      const skill = db.prepare("SELECT star_criteria FROM skill_tree WHERE id = ?").get(metadata.skillId);
      const criteria = parseTeachingJson(skill?.star_criteria, []);
      const criterion = criteria.find((item) => Number(item.star || 0) === Number(metadata.starTo));
      if (criterion?.criterion) metadata.criterion = criterion.criterion;
    }
    return { ...row, metadata };
  }));
});

app.post("/api/teaching/pilot/:id/growth", requireCoachPassword, (req, res) => {
  const now = Date.now();
  const occurredAt = optionalTimestamp(req.body?.occurredAt) || now;
  const type = String(req.body?.type || "coach_comment").trim();
  const detail = String(req.body?.detail || "").trim();
  const label = String(req.body?.label || (type === "coach_comment" ? "教练评语" : "成长记录")).trim();
  if (!detail) return res.status(400).json({ error: "内容不能为空" });
  const result = db.prepare(`
    INSERT INTO pilot_growth_log (pilot_id, event_id, occurred_at, type, label, detail, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.params.id,
    req.body?.eventId || null,
    occurredAt,
    type,
    label,
    detail,
    JSON.stringify(req.body?.metadata || {}),
    now,
  );
  const row = db.prepare("SELECT * FROM pilot_growth_log WHERE id = ?").get(result.lastInsertRowid);
  res.json({ ...row, metadata: parseTeachingJson(row.metadata_json, {}) });
});

app.post("/api/teaching/pilot/:id/growth/:growthId/hidden", requireCoachPassword, (req, res) => {
  const row = db.prepare("SELECT * FROM pilot_growth_log WHERE id = ? AND pilot_id = ?")
    .get(req.params.growthId, req.params.id);
  if (!row) return res.status(404).json({ error: "\u6210\u957f\u8bb0\u5f55\u4e0d\u5b58\u5728" });
  const metadata = parseTeachingJson(row.metadata_json, {});
  const nextMetadata = { ...metadata, hidden: Boolean(req.body?.hidden) };
  if (row.type === "star" && nextMetadata.skillId && nextMetadata.starTo) {
    const skill = db.prepare("SELECT star_criteria FROM skill_tree WHERE id = ?").get(nextMetadata.skillId);
    const criteria = parseTeachingJson(skill?.star_criteria, []);
    const criterion = criteria.find((item) => Number(item.star || 0) === Number(nextMetadata.starTo));
    if (criterion?.criterion) nextMetadata.criterion = criterion.criterion;
  }
  db.prepare("UPDATE pilot_growth_log SET metadata_json = ? WHERE id = ? AND pilot_id = ?")
    .run(JSON.stringify(nextMetadata), req.params.growthId, req.params.id);
  const nextRow = db.prepare("SELECT * FROM pilot_growth_log WHERE id = ?").get(req.params.growthId);
  res.json({ ...nextRow, metadata: nextMetadata });
});

app.delete("/api/teaching/pilot/:id/growth/:growthId", requireCoachPassword, (req, res) => {
  const row = db.prepare("SELECT * FROM pilot_growth_log WHERE id = ? AND pilot_id = ?")
    .get(req.params.growthId, req.params.id);
  if (!row) return res.status(404).json({ error: "\u6210\u957f\u8bb0\u5f55\u4e0d\u5b58\u5728" });

  const metadata = parseTeachingJson(row.metadata_json, {});
  runTransaction(() => {
    if (row.type === "star" && metadata.skillId) {
      const existing = db.prepare("SELECT * FROM pilot_skill_progress WHERE pilot_id = ? AND skill_id = ?")
        .get(req.params.id, metadata.skillId);
      if (existing) {
        const evidence = parseTeachingJson(existing.evidence_json, []);
        const nextEvidence = evidence.filter((item) => Number(item.achieved_at) !== Number(row.occurred_at));
        const nextStars = nextEvidence.reduce((max, item) => Math.max(max, Number(item.star) || 0), 0);
        db.prepare(`INSERT INTO pilot_skill_progress (pilot_id, skill_id, current_stars, evidence_json, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(pilot_id, skill_id) DO UPDATE SET
            current_stars = excluded.current_stars,
            evidence_json = excluded.evidence_json,
            updated_at = excluded.updated_at
        `).run(req.params.id, metadata.skillId, nextStars, JSON.stringify(nextEvidence), Date.now());
      }
    }
    db.prepare("DELETE FROM pilot_growth_log WHERE id = ? AND pilot_id = ?").run(req.params.growthId, req.params.id);
  });

  res.json({ deleted: true });
});

app.get("/api/teaching/stratification", requireCoachPassword, (req, res) => {
  const rows = db.prepare("SELECT * FROM pilot_stratification").all();
  res.json(rows.map((row) => ({ ...row, service_cost: row.phase_value })));
});

app.post("/api/teaching/stratification", requireCoachPassword, (req, res) => {
  const items = Array.isArray(req.body) ? req.body : [];
  const now = Date.now();
  const upsert = db.prepare(`INSERT INTO pilot_stratification
    (pilot_id, training_roi, award_potential, parent_investment, training_enthusiasm, short_term_result_speed, phase_value, quadrant, attention_weight, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(pilot_id) DO UPDATE SET
      training_roi = excluded.training_roi,
      award_potential = excluded.award_potential,
      parent_investment = excluded.parent_investment,
      training_enthusiasm = excluded.training_enthusiasm,
      short_term_result_speed = excluded.short_term_result_speed,
      phase_value = excluded.phase_value,
      quadrant = excluded.quadrant,
      attention_weight = excluded.attention_weight,
      updated_at = excluded.updated_at`);
  let saved = 0;
  for (const item of items) {
    if (!item?.pilot_id) continue;
    upsert.run(
      item.pilot_id,
      Math.max(0, Math.min(100, Number(item.training_roi) || 0)),
      clampTeachingScore(item.award_potential),
      clampTeachingScore(item.parent_investment),
      clampTeachingScore(item.training_enthusiasm),
      clampTeachingScore(item.short_term_result_speed),
      clampTeachingScore(item.service_cost ?? item.phase_value),
      String(item.quadrant || "core"),
      Math.max(0, Number(item.attention_weight) || 0.25),
      now,
    );
    saved += 1;
  }
  res.json({ saved });
});

function parseLessonPlanRow(row) {
  const trainingTasks = parseTeachingJson(row.training_tasks, []);
  const coachActions = parseTeachingJson(row.coach_actions, []);
  const tasksWithActions = trainingTasks.some((task) => Array.isArray(task.coachActions) || Array.isArray(task.coach_actions))
    ? trainingTasks
    : trainingTasks.map((task) => ({
      ...task,
      coachActions: coachActions
        .filter((action) => Number(action.minute || 0) >= Number(task.startMin || 0) && Number(action.minute || 0) <= Number(task.endMin || 0))
        .map((action) => ({ minute: action.minute, action: action.action, priority: action.priority || "normal" })),
    }));
  return {
    id: row.id,
    event_id: row.event_id,
    pilot_id: row.pilot_id,
    target_skills: parseTeachingJson(row.target_skills, []),
    training_tasks: tasksWithActions,
    coach_visit_count: row.coach_visit_count,
    coach_actions: coachActions,
    ai_suggestion: row.ai_suggestion || "",
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function getTeachingEvent(eventId) {
  const row = db.prepare("SELECT * FROM training_events WHERE id = ?").get(eventId);
  return row ? eventFromRow(row) : null;
}

function getPilotSkillSnapshot(pilotId) {
  const skillRows = db.prepare("SELECT * FROM skill_tree ORDER BY category, parent_id IS NOT NULL, sort_order, created_at").all();
  const progressRows = db.prepare("SELECT * FROM pilot_skill_progress WHERE pilot_id = ?").all(pilotId);
  const progressMap = new Map(progressRows.map((row) => [row.skill_id, row]));
  return skillRows.map((skill) => {
    const progress = progressMap.get(skill.id);
    const starCriteria = parseTeachingJson(skill.star_criteria, []);
    return {
      skillId: skill.id,
      name: skill.name,
      category: skill.category,
      parentId: skill.parent_id,
      description: skill.description || "",
      starCriteria,
      currentStars: progress?.current_stars || 0,
      maxStars: Math.max(5, ...starCriteria.map((item) => Number(item.star) || 0)),
    };
  });
}

function getPilotStratification(pilotId) {
  return db.prepare("SELECT * FROM pilot_stratification WHERE pilot_id = ?").get(pilotId) || {
    pilot_id: pilotId,
    training_roi: 50,
    award_potential: 3,
    parent_investment: 3,
    training_enthusiasm: 3,
    short_term_result_speed: 3,
    phase_value: 3,
    service_cost: 3,
    quadrant: "standard",
    attention_weight: 0.25,
  };
}

function normalizeLessonTargets(targets, skills) {
  const skillMap = new Map(skills.map((skill) => [skill.skillId, skill]));
  return (Array.isArray(targets) ? targets : [])
    .map((target) => {
      const skill = skillMap.get(target?.skillId || target?.skill_id);
      if (!skill) return null;
      if (!Array.isArray(skill.starCriteria) || skill.starCriteria.length === 0) return null;
      const targetStar = Math.max(1, Math.min(5, Math.floor(Number(target?.targetStar || target?.target_star || skill.currentStars + 1 || 1))));
      return {
        skillId: skill.skillId,
        name: skill.name,
        targetStar,
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}

function defaultLessonTargets(skills) {
  return skills
    .filter((skill) => Array.isArray(skill.starCriteria) && skill.starCriteria.length > 0)
    .filter((skill) => skill.currentStars < Math.min(5, skill.maxStars || 5))
    .sort((left, right) => left.currentStars - right.currentStars || left.name.localeCompare(right.name, "zh-CN"))
    .slice(0, 2)
    .map((skill) => ({
      skillId: skill.skillId,
      name: skill.name,
      targetStar: Math.min(5, Number(skill.currentStars || 0) + 1),
    }));
}

function normalizeLessonStages(stages) {
  return (Array.isArray(stages) ? stages : [])
    .map((stage, index) => {
      const startMin = Math.max(0, Math.floor(Number(stage?.startMin ?? stage?.start_min ?? index * 10)));
      const endMin = Math.max(startMin + 1, Math.floor(Number(stage?.endMin ?? stage?.end_min ?? index * 10 + 10)));
      return {
        id: String(stage?.id || `stage-${index}`),
        startMin,
        endMin,
        phase: String(stage?.phase || "\u4e13\u9879\u7ec3\u4e60").trim().slice(0, 40),
        content: String(stage?.content || stage?.task || "").trim().slice(0, 200),
        goal: String(stage?.goal || "").trim().slice(0, 160),
        successCriteria: String(stage?.successCriteria || stage?.success_criteria || "").trim().slice(0, 200),
        note: String(stage?.note || stage?.standard || stage?.goal || stage?.successCriteria || "").trim().slice(0, 200),
        source: String(stage?.source || stage?.source_type || "").slice(0, 40),
        coachActionSuggestions: (Array.isArray(stage?.coachActionSuggestions) ? stage.coachActionSuggestions : []).slice(0, 8).map((action) => ({
          relativeMinute: Math.max(startMin, Math.min(endMin, Math.floor(Number(action?.relativeMinute ?? action?.minute ?? startMin)))),
          action: String(action?.action || "观察"),
          priority: String(action?.priority || "normal"),
          focus: String(action?.focus || "").slice(0, 120),
        })),
        coachActions: normalizeStageCoachActions(stage?.coachActions || stage?.coach_actions, startMin, endMin),
      };
    })
    .filter((stage) => stage.content)
    .slice(0, 10);
}

function defaultLessonTeachingManual() {
  return [
    "\u6559\u5b66\u65b9\u6cd5\u624b\u518c\uff1a",
    "1. \u70ed\u8eab\u9636\u6bb5\uff1a\u5148\u786e\u8ba4\u8bbe\u5907\u72b6\u6001\u3001\u624b\u611f\u548c\u57fa\u7840\u7a33\u5b9a\u6027\uff0c\u4e0d\u6025\u4e8e\u4e0a\u96be\u5ea6\u3002",
    "2. \u4e13\u9879\u7ec3\u4e60\uff1a\u56f4\u7ed5\u76ee\u6807\u661f\u661f\u62c6\u6210\u53ef\u91cd\u590d\u4efb\u52a1\uff0c\u4e00\u6b21\u53ea\u6539\u4e00\u4e2a\u5173\u952e\u52a8\u4f5c\u3002",
    "3. \u5f3a\u5316\u4fee\u6b63\uff1a\u5148\u89c2\u5bdf\u518d\u4fee\u6b63\uff0c\u4fee\u6b63\u540e\u8981\u7acb\u5373\u5b89\u6392\u4e00\u8f6e\u590d\u7ec3\u3002",
    "4. \u6d4b\u8bd5\u9a8c\u6536\uff1a\u53ea\u9a8c\u6536\u672c\u8282\u76ee\u6807\uff0c\u7528\u660e\u786e\u6807\u51c6\u5224\u65ad\u662f\u5426\u8fbe\u6807\u3002",
    "5. \u9ad8\u6743\u91cd\u5b66\u5458\u8981\u63d0\u524d\u89c2\u5bdf\u3001\u589e\u52a0\u4fee\u6b63\u548c\u9a8c\u6536\u6b21\u6570\uff1b\u9ad8\u6d88\u8017\u5b66\u5458\u5148\u7acb\u89c4\u5219\u518d\u7ed9\u8d44\u6e90\u3002",
  ].join("\n");
}

function getLessonTeachingManual() {
  const row = db.prepare("SELECT value_json FROM training_settings WHERE key = ?").get(LESSON_TEACHING_MANUAL_KEY);
  return String(safeJsonParse(row?.value_json, defaultLessonTeachingManual()) || defaultLessonTeachingManual());
}

function saveLessonTeachingManual(input) {
  const manual = String(input?.manual || "").slice(0, 12000);
  db.prepare(`
    INSERT INTO training_settings (key, value_json)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
  `).run(LESSON_TEACHING_MANUAL_KEY, JSON.stringify(manual || defaultLessonTeachingManual()));
  return { manual: manual || defaultLessonTeachingManual() };
}

function getLessonSystemPrompt() {
  const row = db.prepare("SELECT value_json FROM training_settings WHERE key = ?").get(LESSON_SYSTEM_PROMPT_KEY);
  return String(safeJsonParse(row?.value_json, defaultLessonSystemPrompt()) || defaultLessonSystemPrompt());
}

function saveLessonSystemPrompt(input) {
  const prompt = String(input?.systemPrompt || "").slice(0, 12000);
  db.prepare(`
    INSERT INTO training_settings (key, value_json)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
  `).run(LESSON_SYSTEM_PROMPT_KEY, JSON.stringify(prompt || defaultLessonSystemPrompt()));
  return { systemPrompt: prompt || defaultLessonSystemPrompt() };
}

function getLessonExtraMaterial() {
  const row = db.prepare("SELECT value_json FROM training_settings WHERE key = ?").get(LESSON_EXTRA_MATERIAL_KEY);
  return String(safeJsonParse(row?.value_json, "") || "");
}

function saveLessonExtraMaterial(input) {
  const material = String(input?.material || "").slice(0, 12000);
  db.prepare(`
    INSERT INTO training_settings (key, value_json)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
  `).run(LESSON_EXTRA_MATERIAL_KEY, JSON.stringify(material));
  return { material };
}

function normalizeLessonBudgetConfig(input = {}) {
  return {
    totalMinutes: Math.max(10, Math.min(720, Math.floor(Number(input.totalMinutes || DEFAULT_LESSON_BUDGET_CONFIG.totalMinutes)))),
    totalCoachBudget: Math.max(1, Math.min(120, Math.floor(Number(input.totalCoachBudget || DEFAULT_LESSON_BUDGET_CONFIG.totalCoachBudget)))),
  };
}

function getLessonBudgetConfig() {
  const row = db.prepare("SELECT value_json FROM training_settings WHERE key = ?").get(LESSON_BUDGET_CONFIG_KEY);
  return normalizeLessonBudgetConfig(safeJsonParse(row?.value_json, DEFAULT_LESSON_BUDGET_CONFIG));
}

function saveLessonBudgetConfig(input) {
  const config = normalizeLessonBudgetConfig(input || {});
  db.prepare(`
    INSERT INTO training_settings (key, value_json)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
  `).run(LESSON_BUDGET_CONFIG_KEY, JSON.stringify(config));
  return { config };
}

function normalizeStageCoachActions(actions, startMin, endMin) {
  const allowed = new Set(["\u8bb2\u89e3", "\u89c2\u5bdf", "\u4fee\u6b63", "\u9a8c\u6536"]);
  return (Array.isArray(actions) ? actions : [])
    .map((action, index) => ({
      id: String(action?.id || `coach-${index}`),
      minute: Math.max(startMin, Math.min(endMin, Math.floor(Number(action?.minute ?? action?.relativeMinute ?? action?.atMin ?? startMin)))),
      action: allowed.has(String(action?.action || "")) ? String(action.action) : "\u89c2\u5bdf",
      priority: String(action?.priority || "normal").slice(0, 20),
      focus: String(action?.focus || "").slice(0, 120),
      source: String(action?.source || action?.source_type || "").slice(0, 40),
    }))
    .slice(0, 8);
}

function flattenCoachActions(stages, pilot) {
  return normalizeLessonStages(stages).flatMap((stage) => (
    (stage.coachActions || []).map((action) => ({
      ...action,
      pilotId: pilot.id,
      pilotName: pilot.name,
      detail: `${stage.phase}: ${stage.content}`,
    }))
  ));
}

function coachTaskId(eventId, pilotId, minute, index) {
  return `task-${eventId}-${pilotId || "group"}-${Math.max(0, Math.floor(Number(minute) || 0))}-${index}`;
}

function buildCoachTasks(eventId) {
  const event = getTeachingEvent(eventId);
  if (!event) return null;
  const planRows = db.prepare("SELECT * FROM lesson_plan WHERE event_id = ? ORDER BY pilot_id").all(eventId);
  const statusRows = db.prepare("SELECT * FROM coach_task_status WHERE event_id = ?").all(eventId);
  const statusById = new Map(statusRows.map((row) => [row.task_id, row]));
  const participantByPilot = new Map((event.participants || []).map((participant) => [participant.pilotId, participant]));
  const tasks = [];
  for (const row of planRows) {
    const plan = parseLessonPlanRow(row);
    const actions = Array.isArray(plan.coach_actions) ? plan.coach_actions : [];
    actions.forEach((action, index) => {
      const minute = Math.max(0, Math.floor(Number(action.minute || action.relativeMinute || 0)));
      const pilotId = action.pilotId || row.pilot_id;
      const participant = participantByPilot.get(pilotId) || null;
      const videoChannel = participant?.videoChannel || "";
      const pilotName = action.pilotName || row.pilot_id;
      const taskId = coachTaskId(eventId, action.pilotId || row.pilot_id, minute, index);
      const status = statusById.get(taskId);
      tasks.push({
        id: taskId,
        eventId,
        pilotId,
        pilotName,
        pilotDisplayName: videoChannel ? `${pilotName} ${videoChannel}` : pilotName,
        videoChannel,
        minute,
        action: action.action || "观察",
        priority: action.priority || "normal",
        focus: action.focus || "",
        detail: action.detail || "",
        source: action.source || "",
        trainingTask: ["讲解", "观察", "修正", "验收"].includes(String(action.action || "")),
        completed: Boolean(status?.completed_at),
        completedAt: status?.completed_at || null,
        completedBy: status?.completed_by || "",
      });
    });
  }
  const customRows = db.prepare("SELECT * FROM coach_custom_tasks WHERE event_id = ? ORDER BY minute ASC, created_at ASC").all(eventId);
  for (const row of customRows) {
    const status = statusById.get(row.task_id);
    tasks.push({
      id: row.task_id,
      eventId,
      pilotId: "",
      pilotName: "全局任务",
      pilotDisplayName: "全局任务",
      videoChannel: "",
      minute: Math.max(0, Math.floor(Number(row.minute || 0))),
      action: row.action || "自定义",
      priority: row.priority || "normal",
      focus: row.focus || "",
      detail: row.focus || "",
      source: "user_custom",
      trainingTask: ["讲解", "观察", "修正", "验收"].includes(String(row.action || "")),
      completed: Boolean(status?.completed_at),
      completedAt: status?.completed_at || null,
      completedBy: status?.completed_by || "",
    });
  }
  tasks.sort((left, right) => (
    left.minute - right.minute
    || String(left.pilotName || "").localeCompare(String(right.pilotName || ""), "zh-CN")
    || String(left.id).localeCompare(String(right.id), "zh-CN")
  ));
  return {
    event,
    tasks,
    generatedAt: Date.now(),
  };
}

function buildEmptyLessonPlan(eventId, pilot, skills, existingTargets = []) {
  const selectedTargets = normalizeLessonTargets(existingTargets, skills);
  const targets = selectedTargets.length ? selectedTargets : defaultLessonTargets(skills);
  return {
    id: `lesson-${eventId}-${pilot.id}`,
    event_id: eventId,
    pilot_id: pilot.id,
    target_skills: targets,
    training_tasks: [],
    coach_visit_count: 0,
    coach_actions: [],
    ai_suggestion: "",
  };
}

function personalLessonOutputSchema() {
  return {
    stages: [
      {
        startMin: 0,
        endMin: 0,
        phase: "",
        content: "",
        note: "",
        coachActions: [
          {
            minute: 0,
            action: "讲解|观察|修正|验收",
            priority: "low|normal|high",
            focus: "",
          },
        ],
      },
    ],
  };
}

function defaultLessonSystemPrompt() {
  return [
    "你是无人机训练智能备课教练。代码只整理目标事实、技能标准、父链和 coachBudget.total，不替你判断教学阶段。",
    "教练选择的目标星星具有最高优先级，禁止替换、删除、降级或自动补全目标。",
    "你必须根据 teachingMethodManual、currentCriterion、targetCriterion、starCriteria、当前技能状态和 coachBudget.total 自行判断怎么教。",
    "必须严格遵守每个 student.coachBudget.total，不要平均分配教练动作，不要自行决定资源分配。",
    "必须严格遵守 lesson.totalMinutes，stages 应覆盖 0 到 lesson.totalMinutes，不要自行缩短课程总时长。",
    "禁止所有学员训练结构完全相同，必须结合目标技能、星级标准、当前学员状态和权重做差异化。",
    "coachActions 只能使用：讲解、观察、修正、验收。",
    "coachActions 必须放在对应 stages[] 里，minute 必须在该 stage 的 startMin/endMin 范围内。",
    "不要返回 pilotId、pilotName、targetSkills、goal、successCriteria、coachVisitCount 等未在 outputSchema 中要求的字段。",
    "只返回 JSON，不要 Markdown，不要解释。",
  ].join("\n");
}

function targetParentChain(skill, skillMap) {
  const chain = [];
  let parentId = skill?.parentId || skill?.parent_id || null;
  const seen = new Set();
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = skillMap.get(parentId);
    if (!parent) break;
    chain.unshift(parent);
    parentId = parent.parentId || parent.parent_id || null;
  }
  return chain;
}

function criterionText(starCriteria, star) {
  const item = (Array.isArray(starCriteria) ? starCriteria : []).find((criterion) => Number(criterion.star || 0) === Number(star || 0));
  return String(item?.criterion || item?.text || item?.description || "");
}

function analyzeStudent(student, skillMap) {
  return (student.targetSkills || []).map((target) => {
    const skill = skillMap.get(target.skillId);
    const currentStars = Number(skill?.currentStars || 0);
    const targetStar = Number(target.targetStar || 1);
    const starCriteria = skill?.starCriteria || [];
    const parentChain = targetParentChain(skill, skillMap);
    return {
      skillId: target.skillId,
      name: target.name || skill?.name || target.skillId,
      currentStars,
      targetStar,
      currentCriterion: criterionText(starCriteria, currentStars),
      targetCriterion: criterionText(starCriteria, targetStar),
      previousCriterion: criterionText(starCriteria, targetStar - 1),
      nextCriterion: criterionText(starCriteria, Math.min(5, targetStar + 1)),
      parentChain: parentChain.map((parent) => parent.name),
      starCriteria,
    };
  });
}

function assignCoachBudget(students, budgetConfig = getLessonBudgetConfig()) {
  const config = normalizeLessonBudgetConfig(budgetConfig);
  const weighted = students.map((student) => ({
    student,
    weight: Math.max(0, Number(student.stratification?.attention_weight || 0)),
  }));
  const fallbackWeight = students.length ? 1 / students.length : 1;
  const rawWeightTotal = weighted.reduce((sum, item) => sum + item.weight, 0);
  const weightTotal = rawWeightTotal || students.length * fallbackWeight || 1;
  return weighted.map((item) => {
    const normalizedWeight = rawWeightTotal ? item.weight : fallbackWeight;
    const total = Math.max(1, Math.round((normalizedWeight / weightTotal) * config.totalCoachBudget));
    return {
      pilotId: item.student.pilotId,
      coachBudget: { total },
    };
  });
}

function enforceCoachBudget(stages, coachBudget) {
  const budget = coachBudget || {};
  let totalRemaining = Math.max(0, Number(budget.total || 0));
  return normalizeLessonStages(stages).map((stage) => {
    const coachActions = [];
    for (const action of stage.coachActions || []) {
      if (totalRemaining <= 0) continue;
      totalRemaining -= 1;
      coachActions.push({
        ...action,
        minute: Math.max(stage.startMin, Math.min(stage.endMin, Number(action.minute || stage.startMin))),
      });
    }
    return { ...stage, coachActions };
  });
}

function buildLessonContext(payload, incomingPlans = [], teachingMethodManual = "", extraMaterial = "", budgetConfig = getLessonBudgetConfig()) {
  const normalizedBudgetConfig = normalizeLessonBudgetConfig(budgetConfig);
  const incomingTargets = new Map(incomingPlans.map((plan) => [plan.pilot_id || plan.pilotId, plan.target_skills || plan.targetSkills || []]));
  const baseStudents = payload.participants.map((participant) => {
    const targetSkills = normalizeLessonTargets(incomingTargets.get(participant.pilotId), participant.skills);
    return {
      pilotId: participant.pilotId,
      pilotName: participant.pilotName,
      targetSkills: targetSkills.length ? targetSkills : defaultLessonTargets(participant.skills),
      stratification: participant.stratification,
      skillMap: new Map(participant.skills.map((skill) => [skill.skillId, skill])),
    };
  });
  const budgets = new Map(assignCoachBudget(baseStudents, normalizedBudgetConfig).map((item) => [item.pilotId, item.coachBudget]));
  const students = baseStudents.map((student) => ({
    pilotId: student.pilotId,
    pilotName: student.pilotName,
    targets: analyzeStudent(student, student.skillMap),
    coachBudget: budgets.get(student.pilotId),
    attention: {
      weight: Number(student.stratification?.attention_weight || 0),
    },
  }));
  return {
    rules: {
      coachActions: ["讲解", "观察", "修正", "验收"],
      antiTemplate: [
        "禁止平均分配教练动作",
        "禁止所有学员同结构",
        "必须遵守 coachBudget",
        "必须由 AI 根据技能标准和教学手册判断训练方式",
      ],
      extraMaterial,
    },
    students,
    event: {
      id: payload.event?.id,
      name: payload.event?.name,
    },
    budgetConfig: normalizedBudgetConfig,
    teachingMethodManual: teachingMethodManual || getLessonTeachingManual(),
  };
}

function lessonSessionKey(eventId, pilotId) {
  return `${eventId}:${pilotId}`;
}

function getLessonSession(eventId, pilotId) {
  const key = lessonSessionKey(eventId, pilotId);
  if (!coachLlmRuntime.lessonSessions.has(key)) {
    coachLlmRuntime.lessonSessions.set(key, { history: [], turns: 0, optimizeCount: 0, regenerateCount: 0, tokenUsage: 0 });
  }
  return coachLlmRuntime.lessonSessions.get(key);
}

function lessonRequestBody(config, messages) {
  const body = applyThinkingMode({
    model: config.model,
    temperature: config.temperature,
    top_p: config.topP,
    max_tokens: config.maxTokens,
    stream: false,
    messages,
    response_format: { type: "json_object" },
  }, config);
  return body;
}

async function postLessonAiJson(config, messages) {
  const controller = new AbortController();
  const lessonTimeoutMs = Math.max(Number(config.timeoutMs || 0), 300000);
  const timeout = setTimeout(() => controller.abort(), lessonTimeoutMs);
  const startedAt = Date.now();
  const body = lessonRequestBody(config, messages);
  const inputJson = JSON.stringify(body);
  try {
    let response;
    try {
      response = await fetch(config.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body: inputJson,
        signal: controller.signal,
      });
    } catch (error) {
      // The public timeout message intentionally hides lower-level request details.
      // eslint-disable-next-line preserve-caught-error
      if (error?.name === "AbortError") throw new Error(`DeepSeek 请求超时：${Math.round(lessonTimeoutMs / 1000)} 秒内没有返回`);
      throw error;
    }
    const text = await response.text();
    if (!response.ok) throw new Error(lessonAiErrorMessage(response.status, text));
    const parsed = safeJsonParse(text, null);
    const content = parsed?.choices?.[0]?.message?.content || text;
    const baseLog = {
      durationMs: Date.now() - startedAt,
      inputChars: inputJson.length,
      outputChars: String(content || text || "").length,
      outputFull: String(content || text || ""),
      tokenUsage: Number(parsed?.usage?.total_tokens || 0),
    };
    const json = parseAiJsonContent(content);
    if (!json) {
      const preview = String(content || text || "").replace(/\s+/g, " ").slice(0, 220);
      const error = new Error(`DeepSeek 返回 JSON 解析失败：${preview || "空响应"}`);
      error.log = { ...baseLog, outputPreview: preview };
      throw error;
    }
    return {
      json,
      content,
      log: baseLog,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function generatePersonalLessonPlan(student, commonContext, options = {}) {
  const config = options.config || getCoachLlmConfig({ includeSecret: true });
  if (!config.apiKey) return { plan: null, log: { pilotId: student.pilotId, error: "未配置 DeepSeek API key" } };
  const session = getLessonSession(commonContext.event.id, student.pilotId);
  if (options.regenerate) session.regenerateCount += 1;
  if (!options.regenerate && options.instruction && session.optimizeCount >= PERSONAL_LESSON_OPTIMIZE_LIMIT) {
    throw new Error(`单人优化最多 ${PERSONAL_LESSON_OPTIMIZE_LIMIT} 次，请直接手动编辑或重新生成`);
  }
  const userPayload = {
    teachingMethodManual: commonContext.teachingMethodManual,
    rules: commonContext.rules,
    lesson: {
      totalMinutes: commonContext.budgetConfig?.totalMinutes,
      totalCoachBudget: commonContext.budgetConfig?.totalCoachBudget,
    },
    student,
    outputSchema: personalLessonOutputSchema(),
    instruction: `请为该单个学员生成完整 ${commonContext.budgetConfig?.totalMinutes || 0} 分钟课程；stages 第一段 startMin 必须为 0，最后一段 endMin 必须为 ${commonContext.budgetConfig?.totalMinutes || 0}。`,
  };
  if (options.instruction) userPayload.extraInstruction = options.instruction;
  const historySource = options.regenerate ? [] : (Array.isArray(options.history) ? options.history : session.history);
  const history = historySource.slice(-4);
  const messages = [
    { role: "system", content: String(options.systemPrompt || defaultLessonSystemPrompt()).slice(0, 6000) },
    ...history.map((item) => ({ role: item.role === "assistant" ? "assistant" : "user", content: String(item.content || "").slice(0, item.role === "assistant" ? 1200 : 1000) })),
    { role: "user", content: JSON.stringify(userPayload) },
  ];
  const result = await postLessonAiJson(config, messages);
  const personalPlan = result.json.personalPlan || result.json;
  session.turns += 1;
  if (!options.regenerate && options.instruction) session.optimizeCount += 1;
  session.tokenUsage += Number(result.log.tokenUsage || 0);
  session.history.push({ role: "user", content: options.instruction || "生成个人教案" });
  session.history.push({ role: "assistant", content: JSON.stringify(personalPlan).slice(0, 1200) });
  session.history = session.history.slice(-8);
  return {
    plan: {
      pilotId: student.pilotId,
      pilotName: student.pilotName,
      targetSkills: student.targets,
      stages: normalizeLessonStages(personalPlan.stages || []),
      coachVisitCount: Math.max(1, Math.min(30, Math.floor(Number(student.coachBudget?.total || 1)))),
      coachActionSuggestions: (personalPlan.stages || []).flatMap((stage, stageIndex) => (
        ([...(stage.coachActionSuggestions || []), ...(stage.coachActions || [])]).map((action) => ({
          ...action,
          stageIndex,
          phase: stage.phase || "",
          relativeMinute: Number(action.relativeMinute ?? action.minute ?? 0),
        }))
      )),
    },
    log: {
      pilotId: student.pilotId,
      pilotName: student.pilotName,
      ...result.log,
      sessionTurns: session.turns,
      optimizeCount: session.optimizeCount,
      optimizeLimit: PERSONAL_LESSON_OPTIMIZE_LIMIT,
      tokenUsage: session.tokenUsage,
      regenerateCount: session.regenerateCount,
    },
  };
}

function buildCoachTimeline(personalPlans, students, budgetConfig = getLessonBudgetConfig()) {
  const config = normalizeLessonBudgetConfig(budgetConfig);
  const studentMap = new Map(students.map((student) => [student.pilotId, student]));
  const candidates = [];
  for (const plan of personalPlans) {
    const student = studentMap.get(plan.pilotId);
    const budgetTotal = Number(student?.coachBudget?.total || 0);
    const attentionWeight = Number(student?.attention?.weight || 0);
    for (const stage of plan.stages || []) {
      const suggestions = (stage.coachActionSuggestions || []).length ? stage.coachActionSuggestions : (stage.coachActions || []);
      for (const suggestion of suggestions) {
        const minute = Math.max(stage.startMin, Math.min(stage.endMin, Number(suggestion.minute ?? suggestion.relativeMinute ?? stage.startMin)));
        candidates.push({
          minute,
          pilotId: plan.pilotId,
          pilotName: plan.pilotName,
          action: suggestion.action || "观察",
          focus: suggestion.focus || stage.goal || stage.content || "",
          phase: stage.phase || "",
          priority: suggestion.priority || "normal",
          budgetTotal,
          attentionWeight,
        });
      }
    }
  }
  const priorityOrder = { high: 0, normal: 1, low: 2 };
  candidates.sort((left, right) => (
    right.budgetTotal - left.budgetTotal
    || right.attentionWeight - left.attentionWeight
    || (priorityOrder[left.priority] ?? 1) - (priorityOrder[right.priority] ?? 1)
    || left.minute - right.minute
  ));
  const selected = [];
  const selectedByPilot = new Map();
  for (const item of candidates) {
    if (selected.length >= 28) break;
    const pilotLimit = Math.max(1, Math.floor(Number(studentMap.get(item.pilotId)?.coachBudget?.total || 1)));
    const used = selectedByPilot.get(item.pilotId) || 0;
    if (used >= pilotLimit) continue;
    if (selected.some((existing) => Math.abs(existing.minute - item.minute) < 2 && existing.pilotId !== item.pilotId)) continue;
    selected.push(item);
    selectedByPilot.set(item.pilotId, used + 1);
  }
  const lowBudgetPlans = personalPlans
    .filter((plan) => Number(studentMap.get(plan.pilotId)?.coachBudget?.total || 0) <= 2)
    .map((plan) => plan.pilotName);
  if (lowBudgetPlans.length >= 2 && selected.length < 30) {
    selected.push({
      minute: Math.min(config.totalMinutes - 5, 12),
      pilotId: "",
      pilotName: lowBudgetPlans.slice(0, 4).join("、"),
      action: "观察",
      focus: "批量观察低关注次数学员状态",
      phase: "批量观察",
      priority: "low",
      budgetTotal: 0,
      attentionWeight: 0,
    });
  }
  return selected
    .sort((left, right) => left.minute - right.minute || right.budgetTotal - left.budgetTotal)
    .slice(0, 30)
    .map((item) => {
      const result = { ...item };
      delete result.priority;
      delete result.budgetTotal;
      delete result.attentionWeight;
      return result;
    });
}

function attachCoachTimelineToPlans(personalPlans, coachTimeline) {
  const timelineByPilot = new Map();
  for (const action of coachTimeline) {
    if (!action.pilotId) continue;
    if (!timelineByPilot.has(action.pilotId)) timelineByPilot.set(action.pilotId, []);
    timelineByPilot.get(action.pilotId).push(action);
  }
  return personalPlans.map((plan) => {
    const actions = timelineByPilot.get(plan.pilotId) || [];
    const stages = (plan.stages || []).map((stage) => ({
      ...stage,
      coachActions: actions
        .filter((action) => action.minute >= stage.startMin && action.minute <= stage.endMin)
        .map((action, index) => ({
          id: `coach-${plan.pilotId}-${stage.id || stage.phase}-${index}`,
          minute: action.minute,
          action: action.action,
          priority: "normal",
          focus: action.focus,
        })),
    }));
    return { ...plan, stages };
  });
}

function lessonAiErrorMessage(status, text) {
  if (status === 504) return "DeepSeek 网关超时，服务端没有在网关限制时间内返回";
  if (/^\s*</.test(String(text || ""))) return `DeepSeek HTTP ${status}，返回了 HTML 错误页`;
  return `DeepSeek HTTP ${status}: ${String(text || "").slice(0, 160)}`;
}

function upsertLessonPlan(plan, now = Date.now()) {
  db.prepare(`INSERT INTO lesson_plan
    (id, event_id, pilot_id, target_skills, training_tasks, coach_visit_count, coach_actions, ai_suggestion, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      target_skills = excluded.target_skills,
      training_tasks = excluded.training_tasks,
      coach_visit_count = excluded.coach_visit_count,
      coach_actions = excluded.coach_actions,
      ai_suggestion = excluded.ai_suggestion,
      updated_at = excluded.updated_at
  `).run(
    plan.id,
    plan.event_id,
    plan.pilot_id,
    JSON.stringify(plan.target_skills || []),
    JSON.stringify(normalizeLessonStages(plan.training_tasks)),
    Math.max(1, Math.min(10, Math.floor(Number(plan.coach_visit_count || 2)))),
    JSON.stringify(plan.coach_actions || flattenCoachActions(plan.training_tasks, { id: plan.pilot_id, name: "" })),
    String(plan.ai_suggestion || ""),
    plan.created_at || now,
    now,
  );
}

function lessonPlanPayload(eventId, meta = {}) {
  const event = getTeachingEvent(eventId);
  if (!event) return null;
  const pilots = new Map(db.prepare("SELECT * FROM pilots").all().map((row) => {
    const pilot = pilotFromRow(row);
    return [pilot.id, pilot];
  }));
  const rows = db.prepare("SELECT * FROM lesson_plan WHERE event_id = ?").all(eventId);
  const plans = new Map(rows.map((row) => [row.pilot_id, parseLessonPlanRow(row)]));
  const participants = event.participants
    .filter((participant) => participant.pilotId)
    .map((participant) => {
      const pilot = pilots.get(participant.pilotId) || { id: participant.pilotId, name: participant.pilotId };
      return {
        ...participant,
        pilotName: pilot.name,
        skills: getPilotSkillSnapshot(participant.pilotId),
        stratification: getPilotStratification(participant.pilotId),
        plan: plans.get(participant.pilotId) || null,
      };
    });
  const lessonTrackRow = getLessonTrackRow();
  const currentTrack = lessonTrackRow ? trackFromRow(lessonTrackRow, { includeChildren: true }) : null;
  const payload = { event, participants, track: currentTrack };
  return {
    ...payload,
    aiContext: {
      systemPrompt: getLessonSystemPrompt(),
      teachingMaterial: JSON.stringify(buildLessonContext(payload, [], getLessonTeachingManual(), getLessonExtraMaterial()), null, 2),
      teachingMethodManual: getLessonTeachingManual(),
      extraTeachingMaterial: getLessonExtraMaterial(),
      budgetConfig: getLessonBudgetConfig(),
      generationSource: meta.source || "",
      generationDetail: meta.detail || coachLlmRuntime.lastError || "",
    },
  };
}

function reviewFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    event_id: row.event_id,
    pilot_id: row.pilot_id,
    task_completion_pct: Number(row.task_completion_pct || 0),
    coach_visit_count: Number(row.coach_visit_count || 0),
    goal_achieved_skills: parseTeachingJson(row.goal_achieved_skills, []),
    deferred_skills: parseTeachingJson(row.deferred_skills, []),
    star_recommendations: parseTeachingJson(row.star_recommendations, []),
    overall_score: Number(row.overall_score || 0),
    coach_note: row.coach_note || "",
    quiz_result: row.quiz_result || "",
    created_at: row.created_at,
    updated_at: row.updated_at || row.created_at,
  };
}

function lessonReviewsForEvent(eventId) {
  return db.prepare("SELECT * FROM lesson_review WHERE event_id = ? ORDER BY created_at ASC")
    .all(eventId)
    .map(reviewFromRow);
}

function deleteLessonReviewGrowthRows(pilotId, eventId, type) {
  const rows = db.prepare("SELECT id, metadata_json FROM pilot_growth_log WHERE pilot_id = ? AND event_id = ? AND type = ?")
    .all(pilotId, eventId, type);
  const deleteGrowth = db.prepare("DELETE FROM pilot_growth_log WHERE id = ?");
  for (const row of rows) {
    const metadata = parseTeachingJson(row.metadata_json, {});
    if (metadata?.source === "lesson_review") deleteGrowth.run(row.id);
  }
}

function formatReviewDuration(ms) {
  const seconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}小时${minutes % 60}分`;
  if (minutes > 0) return `${minutes}分${restSeconds}秒`;
  return `${restSeconds}秒`;
}

function eventSortTime(event) {
  return optionalTimestamp(event?.startedAt) || optionalTimestamp(event?.createdAt) || 0;
}

function getEventParticipantStat(eventId, pilotId) {
  const eventRow = db.prepare("SELECT * FROM training_events WHERE id = ?").get(eventId);
  if (!eventRow) return null;
  const event = eventFromRow(eventRow);
  const overview = readCachedEventOverview(eventId);
  const stat = (overview.stats || []).find((item) => item.pilot_id === pilotId);
  const participant = (event.participants || []).find((item) => item.pilotId === pilotId);
  const window = getParticipantTrainingWindow(event, participant || { pilotId }, Date.now());
  const totalFlightMs = stat?.total_flight_ms || 0;
  const utilization = stat?.utilization ?? (totalFlightMs / Math.max(1, window.end - window.start));
  return {
    eventId,
    eventName: event.name,
    startedAt: event.startedAt || event.createdAt,
    totalFlightMs,
    utilization,
    totalTurtleMs: stat?.total_turtle_ms || 0,
    sampleCount: overview.sampleCounts?.[pilotId] || 0,
  };
}

function latestPreviousParticipantStat(currentEvent, pilotId) {
  const currentTime = eventSortTime(currentEvent);
  const rows = db.prepare("SELECT * FROM training_events ORDER BY COALESCE(started_at, created_at) DESC").all();
  for (const row of rows) {
    const event = eventFromRow(row);
    if (event.id === currentEvent.id || eventSortTime(event) >= currentTime) continue;
    if (!(event.participants || []).some((participant) => participant.pilotId === pilotId)) continue;
    const stat = getEventParticipantStat(event.id, pilotId);
    if (stat) return stat;
  }
  return null;
}

function numericFromText(value) {
  const match = String(value || "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function latestPreviousReview(currentEvent, pilotId) {
  const currentTime = eventSortTime(currentEvent);
  const rows = db.prepare(`
    SELECT review.*, event.started_at, event.created_at
    FROM lesson_review review
    JOIN training_events event ON event.id = review.event_id
    WHERE review.pilot_id = ? AND review.event_id <> ?
    ORDER BY COALESCE(event.started_at, event.created_at) DESC
  `).all(pilotId, currentEvent.id);
  return rows.find((row) => (row.started_at || row.created_at || 0) < currentTime) || null;
}

function comparePilotProgress(currentEvent, pilotId, currentStat = null, currentReview = null) {
  const stat = currentStat || getEventParticipantStat(currentEvent.id, pilotId);
  const previousStat = latestPreviousParticipantStat(currentEvent, pilotId);
  const previousReview = latestPreviousReview(currentEvent, pilotId);
  const flightDeltaMs = stat && previousStat ? stat.totalFlightMs - previousStat.totalFlightMs : null;
  const utilizationDelta = stat && previousStat ? stat.utilization - previousStat.utilization : null;
  const turtleDeltaMs = stat && previousStat ? stat.totalTurtleMs - previousStat.totalTurtleMs : null;
  const currentQuiz = numericFromText(currentReview?.quiz_result);
  const previousQuiz = numericFromText(previousReview?.quiz_result);
  const quizDelta = currentQuiz !== null && previousQuiz !== null ? currentQuiz - previousQuiz : null;
  let direction = "stable";
  const reasons = [];
  if (flightDeltaMs !== null && flightDeltaMs >= 60 * 1000) reasons.push("总飞行时间增加");
  if (utilizationDelta !== null && utilizationDelta >= 0.05) reasons.push("利用率提升");
  if (quizDelta !== null && quizDelta > 0) reasons.push("小测成绩提升");
  if (flightDeltaMs !== null && flightDeltaMs <= -60 * 1000) reasons.push("总飞行时间下降");
  if (utilizationDelta !== null && utilizationDelta <= -0.05) reasons.push("利用率下降");
  if (quizDelta !== null && quizDelta < 0) reasons.push("小测成绩下降");
  const positive = (flightDeltaMs !== null && flightDeltaMs >= 60 * 1000) || (utilizationDelta !== null && utilizationDelta >= 0.05) || (quizDelta !== null && quizDelta > 0);
  const negative = (flightDeltaMs !== null && flightDeltaMs <= -60 * 1000) || (utilizationDelta !== null && utilizationDelta <= -0.05) || (quizDelta !== null && quizDelta < 0);
  if (positive && !negative) direction = "improved";
  else if (negative && !positive) direction = "declined";
  return {
    direction,
    label: direction === "improved" ? "进步" : direction === "declined" ? "下滑" : "持平",
    reasons,
    previousEventId: previousStat?.eventId || "",
    previousEventName: previousStat?.eventName || "",
    flightDeltaMs,
    utilizationDelta,
    turtleDeltaMs,
    quizDelta,
  };
}

function metricArrow(delta) {
  if (delta === null || delta === undefined || !Number.isFinite(Number(delta)) || Number(delta) === 0) return "➡️🙂";
  return Number(delta) > 0 ? "⬆️😎" : "⬇️😟";
}

function syncLessonReviewGrowth({ eventId, pilotId, coachNote, quizResult, occurredAt }) {
  deleteLessonReviewGrowthRows(pilotId, eventId, "coach_comment");
  deleteLessonReviewGrowthRows(pilotId, eventId, "quiz_result");
  deleteLessonReviewGrowthRows(pilotId, eventId, "training_summary");
  const now = Date.now();
  const insertGrowth = db.prepare(`
    INSERT INTO pilot_growth_log (pilot_id, event_id, occurred_at, type, label, detail, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  if (String(coachNote || "").trim()) {
    insertGrowth.run(
      pilotId,
      eventId,
      occurredAt,
      "coach_comment",
      "教练评语",
      String(coachNote || "").trim(),
      JSON.stringify({ source: "lesson_review" }),
      now,
    );
  }
  if (String(quizResult || "").trim()) {
    const quizDetail = String(quizResult || "").trim().replace(/^小测:/, "");
    insertGrowth.run(
      pilotId,
      eventId,
      occurredAt,
      "quiz_result",
      "小测",
      `小测:${quizDetail}`,
      JSON.stringify({ source: "lesson_review" }),
      now,
    );
  }
  const event = getTeachingEvent(eventId);
  const stat = event ? getEventParticipantStat(eventId, pilotId) : null;
  if (event && stat) {
    const comparison = comparePilotProgress(event, pilotId, stat, { quiz_result: quizResult });
    const summaryText = `总飞行 ${formatReviewDuration(stat.totalFlightMs)}${metricArrow(comparison.flightDeltaMs)}\n利用率 ${Math.round((stat.utilization || 0) * 100)}%${metricArrow(comparison.utilizationDelta)}`;
    insertGrowth.run(
      pilotId,
      eventId,
      occurredAt,
      "training_summary",
      summaryText,
      summaryText,
      JSON.stringify({ source: "lesson_review", stat, comparison }),
      now,
    );
  }
}

app.get("/api/teaching/events/:id/plan", requireCoachPassword, (req, res) => {
  const payload = lessonPlanPayload(req.params.id);
  if (!payload) return res.status(404).json({ error: "\u8bad\u7ec3\u4e8b\u4ef6\u4e0d\u5b58\u5728" });
  res.json(payload);
});

app.get("/api/teaching/events/:id/reviews", requireCoachPassword, (req, res) => {
  const event = getTeachingEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "训练事件不存在" });
  res.json({ reviews: lessonReviewsForEvent(req.params.id) });
});

app.put("/api/teaching/events/:id/review/:pilotId", requireCoachPassword, (req, res) => {
  const event = getTeachingEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "训练事件不存在" });
  const participant = (event.participants || []).find((item) => item.pilotId === req.params.pilotId);
  if (!participant) return res.status(404).json({ error: "该飞手不在训练事件中" });
  const now = Date.now();
  const existing = db.prepare("SELECT * FROM lesson_review WHERE event_id = ? AND pilot_id = ?").get(req.params.id, req.params.pilotId);
  const review = {
    id: existing?.id || `review-${req.params.id}-${req.params.pilotId}`,
    event_id: req.params.id,
    pilot_id: req.params.pilotId,
    task_completion_pct: Math.max(0, Math.min(100, Number(req.body?.task_completion_pct ?? existing?.task_completion_pct ?? 0))),
    coach_visit_count: Math.max(0, Math.floor(Number(req.body?.coach_visit_count ?? existing?.coach_visit_count ?? 0))),
    goal_achieved_skills: Array.isArray(req.body?.goal_achieved_skills) ? req.body.goal_achieved_skills : parseTeachingJson(existing?.goal_achieved_skills, []),
    deferred_skills: Array.isArray(req.body?.deferred_skills) ? req.body.deferred_skills : parseTeachingJson(existing?.deferred_skills, []),
    star_recommendations: Array.isArray(req.body?.star_recommendations) ? req.body.star_recommendations : parseTeachingJson(existing?.star_recommendations, []),
    overall_score: Math.max(0, Math.min(100, Number(req.body?.overall_score ?? existing?.overall_score ?? 0))),
    coach_note: String(req.body?.coach_note ?? existing?.coach_note ?? "").trim(),
    quiz_result: String(req.body?.quiz_result ?? existing?.quiz_result ?? "").trim(),
    created_at: existing?.created_at || now,
    updated_at: now,
  };
  runTransaction(() => {
    db.prepare(`
      INSERT INTO lesson_review (
        id, event_id, pilot_id, task_completion_pct, coach_visit_count,
        goal_achieved_skills, deferred_skills, star_recommendations,
        overall_score, coach_note, quiz_result, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        task_completion_pct = excluded.task_completion_pct,
        coach_visit_count = excluded.coach_visit_count,
        goal_achieved_skills = excluded.goal_achieved_skills,
        deferred_skills = excluded.deferred_skills,
        star_recommendations = excluded.star_recommendations,
        overall_score = excluded.overall_score,
        coach_note = excluded.coach_note,
        quiz_result = excluded.quiz_result,
        updated_at = excluded.updated_at
    `).run(
      review.id,
      review.event_id,
      review.pilot_id,
      review.task_completion_pct,
      review.coach_visit_count,
      JSON.stringify(review.goal_achieved_skills),
      JSON.stringify(review.deferred_skills),
      JSON.stringify(review.star_recommendations),
      review.overall_score,
      review.coach_note,
      review.quiz_result,
      review.created_at,
      review.updated_at,
    );
    syncLessonReviewGrowth({
      eventId: req.params.id,
      pilotId: req.params.pilotId,
      coachNote: review.coach_note,
      quizResult: review.quiz_result,
      occurredAt: event.endedAt || event.startedAt || now,
    });
  });
  res.json({ review });
});

function weatherSettingKey(eventId) {
  return `event_weather_${eventId}`;
}

const LAST_WEATHER_LOCATION_KEY = "lastLessonWeatherLocation";
const HISTORY_AI_SUMMARY_CONFIG_KEY = "historyAiSummaryConfig";

function normalizeWeatherCoordinatePair(longitude, latitude) {
  const longitudeText = String(longitude ?? "").trim();
  const latitudeText = String(latitude ?? "").trim();
  if (!longitudeText && !latitudeText) return { longitude: "", latitude: "", valid: true, swapped: false };
  let lon = Number(longitudeText.replace(/[°º]/g, ""));
  let lat = Number(latitudeText.replace(/[°º]/g, ""));
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    return { longitude: "", latitude: "", valid: false, swapped: false };
  }
  let swapped = false;
  if (Math.abs(lat) > 90 && Math.abs(lon) <= 90) {
    [lon, lat] = [lat, lon];
    swapped = true;
  }
  if (Math.abs(lon) > 180 || Math.abs(lat) > 90) {
    return { longitude: "", latitude: "", valid: false, swapped };
  }
  return {
    longitude: rounded(lon, 6),
    latitude: rounded(lat, 6),
    valid: true,
    swapped,
  };
}

function normalizeWeatherConfig(value = {}) {
  const coordinates = normalizeWeatherCoordinatePair(value.longitude, value.latitude);
  return {
    trainingDate: String(value.trainingDate || value.training_date || value.date || "").slice(0, 20),
    longitude: coordinates.longitude,
    latitude: coordinates.latitude,
    lessonWeather: value.lessonWeather || null,
    updatedAt: Number(value.updatedAt || 0),
  };
}

app.get("/api/training-events/:id/weather-config", (req, res) => {
  const event = getTeachingEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "训练事件不存在" });
  const savedForEvent = normalizeWeatherConfig(settingJson(weatherSettingKey(req.params.id), {}));
  const lastLocation = normalizeWeatherConfig(settingJson(LAST_WEATHER_LOCATION_KEY, {}));
  res.json({
    config: {
      ...savedForEvent,
      longitude: savedForEvent.longitude === "" ? lastLocation.longitude : savedForEvent.longitude,
      latitude: savedForEvent.latitude === "" ? lastLocation.latitude : savedForEvent.latitude,
    },
  });
});

app.post("/api/training-events/:id/weather-config", requireCoachPassword, (req, res) => {
  const event = getTeachingEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "训练事件不存在" });
  const coordinates = normalizeWeatherCoordinatePair(req.body?.longitude, req.body?.latitude);
  if (!coordinates.valid) return res.status(400).json({ error: "经纬度格式或范围不正确：经度应为 -180～180，纬度应为 -90～90" });
  const config = normalizeWeatherConfig({ ...(req.body || {}), updatedAt: Date.now() });
  setSettingJson(weatherSettingKey(req.params.id), config);
  if (config.longitude !== "" && config.latitude !== "") {
    setSettingJson(LAST_WEATHER_LOCATION_KEY, {
      longitude: config.longitude,
      latitude: config.latitude,
      updatedAt: config.updatedAt,
    });
  }
  res.json({ config });
});

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function rounded(value, digits) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function weatherQueryPoint(req, res) {
  const coordinates = normalizeWeatherCoordinatePair(req.query.lon, req.query.lat);
  if (!coordinates.valid || coordinates.longitude === "" || coordinates.latitude === "") {
    res.status(400).json({ error: "请填写有效经纬度：经度 -180～180，纬度 -90～90" });
    return null;
  }
  return {
    lon: coordinates.longitude,
    lat: coordinates.latitude,
    swapped: coordinates.swapped,
    location: `${coordinates.longitude},${coordinates.latitude}`,
  };
}

function qweatherErrorResponse(res, error) {
  const code = String(error?.data?.code || error?.status || "");
  const friendlyMessage = ({
    400: "和风天气拒绝了请求参数，请检查经纬度是否填写正确",
    401: "和风天气身份验证失败，请检查项目与凭据配置",
    403: "当前和风天气账号无权访问这个预报服务",
    429: "和风天气请求过于频繁，请稍后再试",
  })[code];
  res.status(error.status || 502).json({
    error: friendlyMessage ? `${friendlyMessage}（${code}）` : (error.message || "QWeather request failed"),
    qweather: error.data || null,
  });
}

app.get("/api/weather/lesson-hourly", async (req, res) => {
  const point = weatherQueryPoint(req, res);
  if (!point) return;
  const date = String(req.query.date || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "date 必须是 YYYY-MM-DD" });
  const startHour = Math.max(0, Math.min(23, Math.floor(Number(req.query.startHour ?? 9))));
  const endHour = Math.max(startHour, Math.min(24, Math.floor(Number(req.query.endHour ?? 18))));
  try {
    const data = await qweatherGet("/v7/weather/168h", {
      location: point.location,
      unit: "m",
      lang: "zh",
    });
    const selected = (data.hourly || [])
      .filter((item) => item.fxTime?.slice(0, 10) === date)
      .filter((item) => {
        const hour = Number(item.fxTime?.slice(11, 13));
        return Number.isFinite(hour) && hour >= startHour && hour <= endHour;
      })
      .map((item) => ({
        time: item.fxTime?.slice(11, 16) || "",
        text: item.text || "",
        temp: finiteNumber(item.temp),
        humidity: finiteNumber(item.humidity),
        pop: item.pop === "" || item.pop == null ? 0 : finiteNumber(item.pop),
        precip: finiteNumber(item.precip),
        windSpeed: finiteNumber(item.windSpeed),
        windScale: item.windScale || "",
      }));

    if (!selected.length) {
      return res.json({
        updateTime: data.updateTime || "",
        date,
        window: { startHour, endHour },
        riskLevel: "unknown",
        maxPop: 0,
        totalPrecip: 0,
        rainHours: 0,
        maxWind: 0,
        avgTemp: 0,
        minTemp: 0,
        maxTemp: 0,
        avgHumidity: 0,
        maxHumidity: 0,
        suggestion: "当前日期超出小时级预报范围或暂无数据。",
        hourly: [],
      });
    }

    const maxPop = Math.max(...selected.map((item) => item.pop));
    const totalPrecip = rounded(selected.reduce((sum, item) => sum + item.precip, 0), 2);
    const rainHours = selected.filter((item) => item.precip > 0).length;
    const maxWind = Math.max(...selected.map((item) => item.windSpeed));
    const avgTemp = rounded(selected.reduce((sum, item) => sum + item.temp, 0) / selected.length, 1);
    const minTemp = Math.min(...selected.map((item) => item.temp));
    const maxTemp = Math.max(...selected.map((item) => item.temp));
    const avgHumidity = rounded(selected.reduce((sum, item) => sum + item.humidity, 0) / selected.length, 1);
    const maxHumidity = Math.max(...selected.map((item) => item.humidity));
    let riskLevel = "low";
    let suggestion = "天气风险较低";
    if (maxWind >= 30) {
      riskLevel = "high";
      suggestion = "风速偏大";
    } else if (totalPrecip >= 3 || maxPop >= 70) {
      riskLevel = "high";
      suggestion = "降雨风险高";
    } else if (totalPrecip > 0 || maxPop >= 40 || maxWind >= 20) {
      riskLevel = "medium";
      suggestion = "存在天气风险";
    }

    res.json({
      updateTime: data.updateTime || "",
      date,
      window: { startHour, endHour },
      riskLevel,
      maxPop,
      totalPrecip,
      rainHours,
      maxWind,
      avgTemp,
      minTemp,
      maxTemp,
      avgHumidity,
      maxHumidity,
      suggestion,
      hourly: selected,
    });
  } catch (error) {
    qweatherErrorResponse(res, error);
  }
});

app.get("/api/weather/minutely", async (req, res) => {
  const point = weatherQueryPoint(req, res);
  if (!point) return;
  try {
    const data = await qweatherGet("/v7/minutely/5m", {
      location: point.location,
      lang: "zh",
    });
    const minutely = (data.minutely || []).map((item) => ({
      time: item.fxTime || "",
      precip: finiteNumber(item.precip),
      type: item.type || "",
    }));
    const precip15 = rounded(minutely.slice(0, 3).reduce((sum, item) => sum + item.precip, 0), 2);
    const precip30 = rounded(minutely.slice(0, 6).reduce((sum, item) => sum + item.precip, 0), 2);
    let riskLevel = "clear";
    let suggestion = "天气正常，可继续训练。";
    let shouldBroadcast = false;
    let broadcastText = "";
    if (precip30 >= 1.5) {
      riskLevel = "high";
      suggestion = "未来30分钟降水明显，请提前准备";
      shouldBroadcast = true;
      broadcastText = "天气预警：未来30分钟降水明显，请提前准备。";
    } else if (precip15 > 0) {
      riskLevel = "watch";
      suggestion = "未来15分钟可能降雨";
      shouldBroadcast = true;
      broadcastText = "天气提醒：未来15分钟可能降雨。";
    }
    res.json({
      updateTime: data.updateTime || "",
      summary: data.summary || "",
      riskLevel,
      precip15,
      precip30,
      suggestion,
      shouldBroadcast,
      broadcastText,
      minutely,
    });
  } catch (error) {
    qweatherErrorResponse(res, error);
  }
});

app.post("/api/teaching/events/:id/lesson-context", requireCoachPassword, (req, res) => {
  const payload = lessonPlanPayload(req.params.id);
  if (!payload) return res.status(404).json({ error: "\u8bad\u7ec3\u4e8b\u4ef6\u4e0d\u5b58\u5728" });
  const incomingPlans = Array.isArray(req.body?.plans) ? req.body.plans : [];
  const teachingMethodManual = String(req.body?.teachingMethodManual || "");
  const teachingMaterial = String(req.body?.teachingMaterial || "");
  const budgetConfig = normalizeLessonBudgetConfig(req.body?.budgetConfig || getLessonBudgetConfig());
  res.json({
    context: buildLessonContext(payload, incomingPlans, teachingMethodManual, teachingMaterial, budgetConfig),
  });
});

app.post("/api/teaching/events/:id/prepare", requireCoachPassword, async (req, res) => {
  const payload = lessonPlanPayload(req.params.id);
  if (!payload) return res.status(404).json({ error: "\u8bad\u7ec3\u4e8b\u4ef6\u4e0d\u5b58\u5728" });
  const incomingPlans = Array.isArray(req.body?.plans) ? req.body.plans : [];
  const instruction = String(req.body?.instruction || "").trim();
  const aiSystemPrompt = String(req.body?.aiSystemPrompt || "");
  if (aiSystemPrompt.trim()) saveLessonSystemPrompt({ systemPrompt: aiSystemPrompt });
  const teachingMaterial = String(req.body?.teachingMaterial || "");
  const teachingMethodManual = String(req.body?.teachingMethodManual || "");
  const budgetConfig = normalizeLessonBudgetConfig(req.body?.budgetConfig || getLessonBudgetConfig());
  const incomingTargets = new Map(incomingPlans.map((plan) => [plan.pilot_id || plan.pilotId, plan.target_skills || plan.targetSkills || []]));
  const now = Date.now();
  let generationSource = "\u89c4\u5219\u515c\u5e95";
  let generationDetail;
  const commonContext = buildLessonContext(payload, incomingPlans, teachingMethodManual, teachingMaterial, budgetConfig);
  const contextByPilot = new Map(commonContext.students.map((student) => [student.pilotId, student]));
  const config = getCoachLlmConfig({ includeSecret: true });
  const totalStartedAt = Date.now();
  const personalPlans = [];
  const failedPilots = [];
  const logs = [];
  for (const student of commonContext.students) {
    try {
      const result = await generatePersonalLessonPlan(student, commonContext, {
        config,
        systemPrompt: aiSystemPrompt,
        instruction,
        regenerate: Boolean(req.body?.regenerate),
      });
      logs.push(result.log);
      if (result.plan?.stages?.length) {
        personalPlans.push(result.plan);
      } else {
        failedPilots.push({ pilotId: student.pilotId, pilotName: student.pilotName, error: result.log?.error || "AI 未返回有效个人教案" });
      }
    } catch (error) {
      const errorLog = {
        pilotId: student.pilotId,
        pilotName: student.pilotName,
        ...(error.log || {}),
        error: error.message || "AI 单人生成失败",
      };
      failedPilots.push({ pilotId: student.pilotId, pilotName: student.pilotName, error: errorLog.error });
      logs.push(errorLog);
    }
  }
  const coachTimeline = buildCoachTimeline(personalPlans, commonContext.students, budgetConfig);
  const scheduledPersonalPlans = attachCoachTimelineToPlans(personalPlans, coachTimeline);
  const aiPlanMap = new Map(scheduledPersonalPlans.map((plan) => [plan.pilotId, plan]));
  if (personalPlans.length) generationSource = "DeepSeek 单人生成";
  generationDetail = `生成 ${personalPlans.length}/${commonContext.students.length} 人；总耗时 ${Date.now() - totalStartedAt}ms`;
  if (!personalPlans.length) {
    return res.json({
      error: "AI生成失败",
      fallbackRequired: true,
      aiLogs: {
        totalDurationMs: Date.now() - totalStartedAt,
        failedPilots,
        personalCalls: logs,
      },
    });
  }
  runTransaction(() => {
    for (const participant of payload.participants) {
      const pilot = { id: participant.pilotId, name: participant.pilotName };
      const aiPlan = aiPlanMap.get(participant.pilotId);
      if (!aiPlan) continue;
      const lessonStudent = contextByPilot.get(participant.pilotId);
      const basePlan = buildEmptyLessonPlan(req.params.id, pilot, participant.skills, incomingTargets.get(participant.pilotId));
      const aiStages = normalizeLessonStages(aiPlan?.stages || aiPlan?.training_tasks || []);
      const budgetedStages = enforceCoachBudget(aiStages, lessonStudent?.coachBudget);
      const plan = {
        ...basePlan,
        target_skills: basePlan.target_skills,
        training_tasks: budgetedStages,
        coach_visit_count: Math.max(1, Math.min(30, Math.floor(Number(lessonStudent?.coachBudget?.total || aiPlan.coachVisitCount || 1)))),
        coach_actions: flattenCoachActions(budgetedStages, pilot),
        ai_suggestion: String(aiPlan.ai_suggestion || ""),
      };
      upsertLessonPlan(plan, now);
      db.prepare(`INSERT INTO coach_live_board
        (event_id, pilot_id, task_progress_json, coach_visits_done, coach_visits_required, is_falling_behind, anomaly_flags, last_coach_action_at, updated_at)
        VALUES (?, ?, ?, 0, ?, 0, '[]', NULL, ?)
        ON CONFLICT(event_id, pilot_id) DO UPDATE SET
          task_progress_json = excluded.task_progress_json,
          coach_visits_required = excluded.coach_visits_required,
          updated_at = excluded.updated_at
      `).run(req.params.id, participant.pilotId, JSON.stringify(plan.training_tasks || []), plan.coach_visit_count, now);
    }
  });
  const nextPayload = lessonPlanPayload(req.params.id, { source: generationSource, detail: generationDetail });
  res.json({
    ...nextPayload,
    lessonSummary: { totalMinutes: budgetConfig.totalMinutes, theme: payload.event?.name || "" },
    coachTimeline,
    aiLogs: {
      totalDurationMs: Date.now() - totalStartedAt,
      failedPilots,
      personalCalls: logs,
    },
  });
});

app.post("/api/teaching/events/:id/plan/:pilotId/ai", requireCoachPassword, async (req, res) => {
  const payload = lessonPlanPayload(req.params.id);
  if (!payload) return res.status(404).json({ error: "\u8bad\u7ec3\u4e8b\u4ef6\u4e0d\u5b58\u5728" });
  const participant = payload.participants.find((item) => item.pilotId === req.params.pilotId);
  if (!participant) return res.status(404).json({ error: "\u8be5\u98de\u624b\u4e0d\u5728\u8bad\u7ec3\u4e8b\u4ef6\u4e2d" });
  const incomingPlans = Array.isArray(req.body?.plans) ? req.body.plans : [];
  const instruction = String(req.body?.instruction || "").trim();
  const teachingMethodManual = String(req.body?.teachingMethodManual || "");
  const teachingMaterial = String(req.body?.teachingMaterial || "");
  const aiSystemPrompt = String(req.body?.aiSystemPrompt || "");
  const budgetConfig = normalizeLessonBudgetConfig(req.body?.budgetConfig || getLessonBudgetConfig());
  const commonContext = buildLessonContext(payload, incomingPlans, teachingMethodManual, teachingMaterial, budgetConfig);
  const student = commonContext.students.find((item) => item.pilotId === req.params.pilotId);
  const config = getCoachLlmConfig({ includeSecret: true });
  let result;
  try {
    result = await generatePersonalLessonPlan(student, commonContext, {
      config,
      systemPrompt: aiSystemPrompt,
      instruction,
      regenerate: Boolean(req.body?.regenerate),
    });
  } catch (error) {
    const errorLog = {
      pilotId: req.params.pilotId,
      pilotName: participant.pilotName,
      ...(error.log || {}),
      error: error.message || "AI 单人生成失败",
    };
    return res.json({
      error: "AI生成失败",
      fallbackRequired: true,
      log: errorLog,
      session: getLessonSession(req.params.id, req.params.pilotId),
    });
  }
  if (!result.plan?.stages?.length) {
    return res.json({
      error: "AI生成失败",
      fallbackRequired: true,
      log: result.log,
      session: getLessonSession(req.params.id, req.params.pilotId),
    });
  }
  const coachTimeline = buildCoachTimeline([result.plan], [student], budgetConfig);
  const [scheduledPlan] = attachCoachTimelineToPlans([result.plan], coachTimeline);
  const existingTargets = new Map(incomingPlans.map((plan) => [plan.pilot_id || plan.pilotId, plan.target_skills || plan.targetSkills || []]));
  const basePlan = buildEmptyLessonPlan(req.params.id, { id: participant.pilotId, name: participant.pilotName }, participant.skills, existingTargets.get(participant.pilotId));
  const plan = {
    ...basePlan,
    training_tasks: enforceCoachBudget(scheduledPlan.stages, student.coachBudget),
    coach_visit_count: Math.max(1, Math.min(30, Number(student.coachBudget?.total || scheduledPlan.coachVisitCount || 1))),
    coach_actions: flattenCoachActions(scheduledPlan.stages, { id: participant.pilotId, name: participant.pilotName }),
  };
  upsertLessonPlan(plan, Date.now());
  res.json({
    plan: parseLessonPlanRow(db.prepare("SELECT * FROM lesson_plan WHERE id = ?").get(plan.id)),
    coachTimeline,
    log: result.log,
    session: getLessonSession(req.params.id, req.params.pilotId),
  });
});

app.put("/api/teaching/events/:id/plans", requireCoachPassword, (req, res) => {
  const payload = lessonPlanPayload(req.params.id);
  if (!payload) return res.status(404).json({ error: "\u8bad\u7ec3\u4e8b\u4ef6\u4e0d\u5b58\u5728" });
  const incomingPlans = Array.isArray(req.body?.plans) ? req.body.plans : [];
  const plansByPilot = new Map(incomingPlans.map((plan) => [String(plan?.pilot_id || plan?.pilotId || ""), plan]));
  const now = Date.now();

  runTransaction(() => {
    for (const participant of payload.participants) {
      const incoming = plansByPilot.get(participant.pilotId);
      if (!incoming) continue;
      const plan = {
        id: `lesson-${req.params.id}-${participant.pilotId}`,
        event_id: req.params.id,
        pilot_id: participant.pilotId,
        target_skills: normalizeLessonTargets(incoming.target_skills, participant.skills),
        training_tasks: normalizeLessonStages(incoming.training_tasks),
        coach_visit_count: Math.max(1, Math.min(10, Math.floor(Number(incoming.coach_visit_count || 2)))),
        coach_actions: flattenCoachActions(incoming.training_tasks, { id: participant.pilotId, name: participant.pilotName }),
        ai_suggestion: String(incoming.ai_suggestion || ""),
      };
      upsertLessonPlan(plan, now);
    }
  });
  res.json(lessonPlanPayload(req.params.id));
});

app.put("/api/teaching/events/:id/plan/:pilotId", requireCoachPassword, (req, res) => {
  const payload = lessonPlanPayload(req.params.id);
  if (!payload) return res.status(404).json({ error: "\u8bad\u7ec3\u4e8b\u4ef6\u4e0d\u5b58\u5728" });
  const participant = payload.participants.find((item) => item.pilotId === req.params.pilotId);
  if (!participant) return res.status(404).json({ error: "\u8be5\u98de\u624b\u4e0d\u5728\u8bad\u7ec3\u4e8b\u4ef6\u4e2d" });
  const now = Date.now();
  const plan = {
    id: `lesson-${req.params.id}-${req.params.pilotId}`,
    event_id: req.params.id,
    pilot_id: req.params.pilotId,
    target_skills: normalizeLessonTargets(req.body?.target_skills, participant.skills),
    training_tasks: normalizeLessonStages(req.body?.training_tasks),
    coach_visit_count: Math.max(1, Math.min(10, Math.floor(Number(req.body?.coach_visit_count || 2)))),
    coach_actions: flattenCoachActions(req.body?.training_tasks, { id: req.params.pilotId, name: participant.pilotName }),
    ai_suggestion: String(req.body?.ai_suggestion || ""),
  };
  upsertLessonPlan(plan, now);
  res.json({ plan: parseLessonPlanRow(db.prepare("SELECT * FROM lesson_plan WHERE id = ?").get(plan.id)) });
});

app.post("/api/teaching/pilot/:id/skills/:skillId", requireCoachPassword, (req, res) => {
  const now = Date.now();
  const stars = Math.max(0, Math.min(5, Math.floor(Number(req.body?.stars || 0))));
  const method = String(req.body?.method || "\u6559\u7ec3\u8bc4\u4f30");
  const note = String(req.body?.note || "");
  const eventId = req.body?.event_id || null;
  const skillRow = db.prepare("SELECT name, star_criteria FROM skill_tree WHERE id = ?").get(req.params.skillId);
  if (!skillRow) return res.status(404).json({ error: "\u6280\u80fd\u70b9\u4e0d\u5b58\u5728" });
  const criteria = parseTeachingJson(skillRow.star_criteria, []);
  if (!Array.isArray(criteria) || criteria.length === 0) {
    return res.status(400).json({ error: "\u6807\u9898\u7c7b\u6280\u80fd\u8282\u70b9\u4e0d\u80fd\u8bbe\u7f6e\u661f\u7ea7" });
  }

  const existing = db.prepare("SELECT * FROM pilot_skill_progress WHERE pilot_id = ? AND skill_id = ?")
    .get(req.params.id, req.params.skillId);
  const oldStars = existing?.current_stars || 0;

  const evidence = existing ? parseTeachingJson(existing.evidence_json, []) : [];
  if (stars > oldStars) {
    evidence.push({ star: stars, achieved_at: now, method, note, event_id: eventId });
  }

  db.prepare(`INSERT INTO pilot_skill_progress (pilot_id, skill_id, current_stars, evidence_json, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(pilot_id, skill_id) DO UPDATE SET
      current_stars = excluded.current_stars,
      evidence_json = excluded.evidence_json,
      updated_at = excluded.updated_at
  `).run(req.params.id, req.params.skillId, stars, JSON.stringify(evidence), now);

  if (stars > oldStars) {
    const skillName = skillRow?.name || req.params.skillId;
    const criterion = criteria.find((item) => Number(item.star || 0) === Number(stars));
    db.prepare(`INSERT INTO pilot_growth_log (pilot_id, event_id, occurred_at, type, label, detail, metadata_json, created_at)
      VALUES (?, ?, ?, 'star', ?, ?, ?, ?)`).run(
      req.params.id,
      eventId,
      now,
      `${skillName} \u5df2\u70b9\u4eae${stars} \u9897\u661f`,
      `${method}${note ? "\uff1a" + note : ""}`,
      JSON.stringify({ starFrom: oldStars, starTo: stars, skillId: req.params.skillId, criterion: criterion?.criterion || "" }),
      now,
    );
  }

  res.json({ pilot_id: req.params.id, skill_id: req.params.skillId, stars, updated_at: now });
});

app.get("/api/coach/overview", requireCoachPassword, (req, res) => {
  res.json(getCoachSnapshot());
});

app.get("/api/coach/llm-config", requireCoachPassword, (req, res) => {
  res.json(getCoachLlmConfig());
});

app.post("/api/coach/llm-config", requireCoachPassword, (req, res) => {
  res.json(saveCoachLlmConfig(req.body || {}));
});

app.get("/api/ai-summary-config", requireCoachPassword, (req, res) => {
  res.json(settingJson(HISTORY_AI_SUMMARY_CONFIG_KEY, {
    includeTasks: true,
    includeReviews: true,
    systemPrompt: getCoachLlmConfig().systemPrompt || "",
  }));
});

app.post("/api/ai-summary-config", requireCoachPassword, (req, res) => {
  const config = {
    includeTasks: req.body?.includeTasks !== false,
    includeReviews: req.body?.includeReviews !== false,
    systemPrompt: String(req.body?.systemPrompt || getCoachLlmConfig().systemPrompt || "").slice(0, 4000),
  };
  setSettingJson(HISTORY_AI_SUMMARY_CONFIG_KEY, config);
  res.json(config);
});

app.get("/api/teaching/lesson-manual", requireCoachPassword, (req, res) => {
  res.json({ manual: getLessonTeachingManual() });
});

app.post("/api/teaching/lesson-manual", requireCoachPassword, (req, res) => {
  res.json(saveLessonTeachingManual(req.body || {}));
});

app.get("/api/teaching/lesson-system-prompt", requireCoachPassword, (req, res) => {
  res.json({ systemPrompt: getLessonSystemPrompt() });
});

app.post("/api/teaching/lesson-system-prompt", requireCoachPassword, (req, res) => {
  res.json(saveLessonSystemPrompt(req.body || {}));
});

app.get("/api/teaching/lesson-extra-material", requireCoachPassword, (req, res) => {
  res.json({ material: getLessonExtraMaterial() });
});

app.post("/api/teaching/lesson-extra-material", requireCoachPassword, (req, res) => {
  res.json(saveLessonExtraMaterial(req.body || {}));
});

app.get("/api/teaching/lesson-budget-config", requireCoachPassword, (req, res) => {
  res.json({ config: getLessonBudgetConfig() });
});

app.post("/api/teaching/lesson-budget-config", requireCoachPassword, (req, res) => {
  res.json(saveLessonBudgetConfig(req.body?.config || req.body || {}));
});

app.post("/api/coach/llm-suggestions/:pilotId", requireCoachPassword, async (req, res) => {
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

app.post("/api/coach/event-summary", requireCoachPassword, async (req, res) => {
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

app.post("/api/events/:id/ai-summary", requireCoachPassword, async (req, res) => {
  try {
    const snapshots = historyEventSnapshots(req.params.id);
    if (!snapshots) return res.status(404).json({ error: "event not found" });
    const config = getCoachLlmConfig({ includeSecret: true });
    if (!config.apiKey) return res.status(400).json({ error: "LLM API key is required" });
    const summaryConfig = {
      includeTasks: req.body?.config?.includeTasks !== false,
      includeReviews: req.body?.config?.includeReviews !== false,
      systemPrompt: String(req.body?.config?.systemPrompt || config.systemPrompt || "").slice(0, 4000),
    };
    const systemPrompt = `${summaryConfig.systemPrompt}`;
    const scope = req.body?.scope === "student" ? "student" : "class";
    const now = Date.now();
    const currentStore = settingJson(`event_ai_summary_${req.params.id}`, { classSummary: null, studentSummaries: {} }) || {};
    let result;
    if (scope === "student") {
      const pilotId = String(req.body?.pilotId || "");
      const pilotSnapshot = snapshots.pilotSnapshots.find((item) => item.pilotId === pilotId);
      if (!pilotSnapshot) return res.status(404).json({ error: "pilot not found in event" });
      const requestPilotSnapshot = summaryConfig.includeReviews ? pilotSnapshot : { ...pilotSnapshot, review: null };
      const requestResult = await requestHistoryStudentSummary(config, snapshots.event, requestPilotSnapshot, systemPrompt);
      result = requestResult.summary;
      currentStore.studentSummaries = {
        ...(currentStore.studentSummaries || {}),
        [pilotId]: {
          ...result,
          scope,
          pilotId,
          pilotName: pilotSnapshot.pilotName,
          eventId: snapshots.event.id,
          generatedAt: now,
          config: summaryConfig,
        },
      };
    } else {
      const pilotSnapshots = summaryConfig.includeReviews
        ? snapshots.pilotSnapshots
        : snapshots.pilotSnapshots.map((item) => ({ ...item, review: null }));
      const tasks = summaryConfig.includeTasks ? buildCoachTasks(req.params.id)?.tasks || [] : [];
      const requestResult = await requestHistoryClassSummary(config, snapshots.event, pilotSnapshots, tasks, systemPrompt);
      result = requestResult.summary;
      currentStore.classSummary = {
        ...result,
        scope,
        eventId: snapshots.event.id,
        eventName: snapshots.event.name,
        generatedAt: now,
        config: summaryConfig,
      };
    }
    currentStore.updatedAt = now;
    setSettingJson(`event_ai_summary_config_${req.params.id}`, summaryConfig);
    setSettingJson(HISTORY_AI_SUMMARY_CONFIG_KEY, summaryConfig);
    setSettingJson(`event_ai_summary_${req.params.id}`, currentStore);
    res.json({ ok: true, scope, summary: result, aiSummary: currentStore, config: summaryConfig });
  } catch (error) {
    coachLlmRuntime.lastError = error.message || "history ai summary failed";
    res.status(500).json({ error: coachLlmRuntime.lastError });
  }
});

app.get("/api/training-events/:id/coach-tasks", requireCoachPassword, (req, res) => {
  const payload = buildCoachTasks(req.params.id);
  if (!payload) return res.status(404).json({ error: "event not found" });
  res.json(payload);
});

function trainingMediaForEvent(eventId) {
  return db.prepare(`
    SELECT id, event_id, url, caption, captured_at, created_at
    FROM training_event_media
    WHERE event_id = ?
    ORDER BY captured_at DESC, created_at DESC
    LIMIT 80
  `).all(eventId).map((row) => ({
    id: row.id,
    eventId: row.event_id,
    url: row.url,
    caption: row.caption,
    capturedAt: row.captured_at,
    createdAt: row.created_at,
  }));
}

function removeTrainingMediaFile(url) {
  const fileName = path.basename(String(url || ""));
  if (!fileName) return;
  const filePath = path.resolve(trainingMediaDir, fileName);
  const safeRoot = `${path.resolve(trainingMediaDir)}${path.sep}`;
  if (!filePath.startsWith(safeRoot)) return;
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function removeTrainingMediaForEvent(eventId) {
  const rows = db.prepare("SELECT url FROM training_event_media WHERE event_id = ?").all(eventId);
  db.prepare("DELETE FROM training_event_media WHERE event_id = ?").run(eventId);
  for (const row of rows) removeTrainingMediaFile(row.url);
}

app.get("/api/training-events/:id/media", (req, res) => {
  const event = getTeachingEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "训练事件不存在" });
  res.json({ media: trainingMediaForEvent(req.params.id) });
});

app.post("/api/training-events/:id/media", requireCoachPassword, (req, res) => {
  const event = getTeachingEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "训练事件不存在" });
  const dataUrl = String(req.body?.dataUrl || "");
  const match = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i.exec(dataUrl);
  if (!match) return res.status(400).json({ error: "请选择 PNG、JPEG 或 WebP 图片" });
  const ext = match[1].toLowerCase() === "jpeg" ? "jpg" : match[1].toLowerCase();
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > 8 * 1024 * 1024) {
    return res.status(400).json({ error: "单张图片需小于 8MB" });
  }
  const now = Date.now();
  const capturedAt = Math.max(1, Number(req.body?.capturedAt) || now);
  const capturedDate = new Date(capturedAt);
  const padDatePart = (value, width = 2) => String(value).padStart(width, "0");
  const dateFileName = [
    capturedDate.getFullYear(),
    padDatePart(capturedDate.getMonth() + 1),
    padDatePart(capturedDate.getDate()),
  ].join("-");
  const timeFileName = [
    padDatePart(capturedDate.getHours()),
    padDatePart(capturedDate.getMinutes()),
    padDatePart(capturedDate.getSeconds()),
  ].join("-");
  const mediaId = `media-${now}-${crypto.randomBytes(5).toString("hex")}`;
  const fileName = `${dateFileName}_${timeFileName}-${padDatePart(capturedDate.getMilliseconds(), 3)}-${crypto.randomBytes(3).toString("hex")}.${ext}`;
  fs.writeFileSync(path.join(trainingMediaDir, fileName), buffer);
  db.prepare(`
    INSERT INTO training_event_media (id, event_id, url, caption, captured_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    mediaId,
    req.params.id,
    `/uploads/training/${fileName}`,
    String(req.body?.caption || "").trim().slice(0, 120),
    capturedAt,
    now,
  );
  res.json({ ok: true, media: trainingMediaForEvent(req.params.id) });
});

app.delete("/api/training-events/:eventId/media/:mediaId", requireCoachPassword, (req, res) => {
  const row = db.prepare("SELECT id, url FROM training_event_media WHERE id = ? AND event_id = ?")
    .get(req.params.mediaId, req.params.eventId);
  if (!row) return res.status(404).json({ error: "图片不存在" });
  db.prepare("DELETE FROM training_event_media WHERE id = ? AND event_id = ?")
    .run(req.params.mediaId, req.params.eventId);
  removeTrainingMediaFile(row.url);
  res.json({ ok: true, media: trainingMediaForEvent(req.params.eventId) });
});

app.post("/api/teaching/events/:id/coach-custom-actions", requireCoachPassword, (req, res) => {
  const event = getTeachingEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "event not found" });
  const now = Date.now();
  const taskId = `custom-${req.params.id}-${now}-${crypto.randomBytes(3).toString("hex")}`;
  db.prepare(`INSERT INTO coach_custom_tasks
    (event_id, task_id, minute, action, priority, focus, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.params.id,
    taskId,
    Math.max(0, Math.floor(Number(req.body?.minute || 0))),
    String(req.body?.action || "自定义").slice(0, 40),
    String(req.body?.priority || "normal").slice(0, 20),
    String(req.body?.focus || "").slice(0, 240),
    now,
    now,
  );
  res.json(buildCoachTasks(req.params.id));
});

app.delete("/api/teaching/events/:id/coach-custom-actions/:taskId", requireCoachPassword, (req, res) => {
  db.prepare("DELETE FROM coach_custom_tasks WHERE event_id = ? AND task_id = ?").run(req.params.id, req.params.taskId);
  db.prepare("DELETE FROM coach_task_status WHERE event_id = ? AND task_id = ?").run(req.params.id, req.params.taskId);
  const payload = buildCoachTasks(req.params.id);
  if (!payload) return res.status(404).json({ error: "event not found" });
  res.json(payload);
});

app.post("/api/training-events/:id/coach-tasks/:taskId/complete", requireCoachPassword, (req, res) => {
  const payload = buildCoachTasks(req.params.id);
  if (!payload) return res.status(404).json({ error: "event not found" });
  const task = payload.tasks.find((item) => item.id === req.params.taskId);
  if (!task) return res.status(404).json({ error: "task not found" });
  const completed = req.body?.completed !== false;
  const now = Date.now();
  if (completed) {
    db.prepare(`INSERT INTO coach_task_status (event_id, task_id, completed_at, completed_by, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(event_id, task_id) DO UPDATE SET
        completed_at = excluded.completed_at,
        completed_by = excluded.completed_by,
        updated_at = excluded.updated_at
    `).run(req.params.id, req.params.taskId, now, String(req.body?.completedBy || "coach").slice(0, 80), now);
  } else {
    db.prepare("DELETE FROM coach_task_status WHERE event_id = ? AND task_id = ?").run(req.params.id, req.params.taskId);
  }
  res.json(buildCoachTasks(req.params.id));
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
        stat.lastFlightEndedAt ?? null,
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
  const includeSegments = req.query.includeSegments !== "0";
  if (includeSegments) ensureEventTimelineCurrent?.(req.params.id, Date.now());
  const cachedOverview = readCachedEventOverview(req.params.id, { includeSegments });
  if (req.query.recompute !== "1") {
    return res.json({
      ...cachedOverview,
      timeline: getEventTimelineStatus?.(req.params.id, Date.now()) || null,
    });
  }
  const event = eventFromRow(eventRow);
  const overview = computeEventOverview(event, req.params.id);
  persistEventOverview(req.params.id, overview);
  res.json({
    stats: overview.stats,
    segments: includeSegments ? overview.segments : [],
    timeline: getEventTimelineStatus?.(req.params.id, Date.now()) || null,
  });
});

return {
  buildCoachTasks,
  comparePilotProgress,
  getEventParticipantStat,
  getTeachingEvent,
  lessonReviewsForEvent,
  removeTrainingMediaForEvent,
};
}
