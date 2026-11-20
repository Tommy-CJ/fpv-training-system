import { useEffect, useMemo, useRef, useState } from "react";
import { apiPost, buttonStyle, dangerButtonStyle, inputStyle, panelStyle, primaryButtonStyle, videoChannels } from "../trainingShared.js";
import { availableVideoNumbers, duplicateVideoChannel } from "../eventFrequency.js";
import { getCoachPassword, setCoachPassword, validateCoachPassword } from "../authConfig.js";

const lessonActionOptions = ["讲解", "观察", "修正", "验收"];
// 视觉参数：备课技能树目标选择窗口高度，复用飞手档案的小预览尺寸。
const LESSON_SKILL_TREE_H = 210;
// 视觉参数：备课思维导图小节点宽度，影响目标星星点击区的横向密度。
const LESSON_SKILL_NODE_W = 140;
// 视觉参数：备课思维导图小节点高度，影响技能名和星星是否拥挤。
const LESSON_SKILL_NODE_H = 60;
// 视觉参数：备课技能树默认完整预览的最小缩放。
const LESSON_SKILL_MIN_ZOOM = 0.25;
// 视觉参数：备课纵向时间轴编辑区高度，太低会频繁滚动。
const LESSON_TIMELINE_H = 360;
async function apiJson(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-coach-password": getCoachPassword(),
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const text = await response.text();
    let message = text || `HTTP ${response.status}`;
    try {
      const payload = JSON.parse(text);
      message = payload.error || payload.message || message;
    } catch {
      // 保留服务端原始错误文本。
    }
    throw new Error(message);
  }
  const text = await response.text();
  const trimmed = text.trim();
  if (trimmed.startsWith("<!doctype") || trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html")) {
    throw new Error(`后端接口未命中：${path}。请重启 server 后再试。`);
  }
  return trimmed ? JSON.parse(trimmed) : {};
}

function coachGet(path) {
  return apiJson(path, { method: "GET" });
}

function coachPost(path, data) {
  return apiJson(path, { method: "POST", body: JSON.stringify(data || {}) });
}

function coachPut(path, data) {
  return apiJson(path, { method: "PUT", body: JSON.stringify(data || {}) });
}

function coachDelete(path) {
  return apiJson(path, { method: "DELETE" });
}

function makeParticipant(pilot, index) {
  return {
    pilotId: pilot?.id || "",
    receiverId: index + 1,
    videoBand: "",
    videoChannel: "",
    trainingStartAt: null,
    trainingEndAt: null,
  };
}

function makeEvent() {
  const now = Date.now();
  return {
    id: `event-${now}`,
    name: "",
    createdAt: now,
    startedAt: null,
    endedAt: null,
    active: false,
    participants: [],
    records: [],
  };
}

const videoBandOptions = Array.from(new Set(videoChannels.all.map((channel) => channel[0])));

function formatDateTimeLocal(ms) {
  if (!ms) return "";
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseDateTimeLocal(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function formatSerialTime(ms) {
  if (!ms) return "暂无";
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return `${seconds} 秒前`;
}

function quadrantText(value) {
  return {
    core: "S/A 核心资产",
    potential: "R 高潜高耗",
    standard: "B 标准兴趣",
    risk: "C 亏损风险",
  }[value] || "未分层";
}

function makeEmptyPlan(eventId, participant) {
  return {
    id: `lesson-${eventId}-${participant.pilotId}`,
    event_id: eventId,
    pilot_id: participant.pilotId,
    target_skills: [],
    training_tasks: [],
    coach_visit_count: 2,
    coach_actions: [],
    ai_suggestion: "",
  };
}

function defaultBudgetConfig() {
  // 用户可调参数：课程总时长，以及本节课教练可分配的总关注次数。
  return {
    totalMinutes: 40,
    totalCoachBudget: 40,
  };
}

function normalizePanelPlan(eventId, participant) {
  return participant.plan || makeEmptyPlan(eventId, participant);
}

function targetKey(skillId, star) {
  return `${skillId}:${star}`;
}

function hasLessonSkillStars(skill) {
  return Array.isArray(skill?.starCriteria) && skill.starCriteria.length > 0;
}

function lessonStarCriterion(skill, star) {
  const item = (Array.isArray(skill?.starCriteria) ? skill.starCriteria : [])
    .find((criterion) => Number(criterion?.star || 0) === Number(star || 0));
  return String(item?.criterion || item?.text || item?.description || "").trim();
}

function buildLessonSkillLayout(skills) {
  const childrenByParent = new Map();
  for (const skill of skills) {
    const key = skill.parentId || "__root__";
    childrenByParent.set(key, [...(childrenByParent.get(key) || []), skill]);
  }
  const layout = new Map();
  let cursorY = 12;
  function place(skill, depth) {
    const children = childrenByParent.get(skill.skillId) || [];
    const startY = cursorY;
    if (children.length) {
      for (const child of children) place(child, depth + 1);
      const endY = cursorY - 88;
      layout.set(skill.skillId, { x: 12 + depth * (LESSON_SKILL_NODE_W + 64), y: (startY + endY) / 2 });
    } else {
      layout.set(skill.skillId, { x: 12 + depth * (LESSON_SKILL_NODE_W + 64), y: cursorY });
      cursorY += LESSON_SKILL_NODE_H + 22;
    }
  }
  const roots = childrenByParent.get("__root__") || skills.filter((skill) => !skill.parentId);
  for (const root of roots) {
    place(root, 0);
  }
  const maxDepth = Math.max(0, ...[...layout.values()].map((item) => Math.floor((item.x - 12) / (LESSON_SKILL_NODE_W + 64))));
  return {
    layout,
    width: 24 + (maxDepth + 1) * LESSON_SKILL_NODE_W + maxDepth * 64,
    height: Math.max(LESSON_SKILL_TREE_H - 20, cursorY + 12),
  };
}

function LessonSkillMindMap({ participant, plan, onChange }) {
  const skills = useMemo(() => participant.skills || [], [participant.skills]);
  const { layout, width, height } = useMemo(() => buildLessonSkillLayout(skills), [skills]);
  const targets = plan.target_skills || [];
  const targetSet = new Set(targets.map((target) => targetKey(target.skillId, target.targetStar)));
  const viewRef = useRef(null);
  const [zoom, setZoom] = useState(0.8);
  const [pan, setPan] = useState({ x: 10, y: 10 });
  const [drag, setDrag] = useState(null);

  useEffect(() => {
    if (!skills.length) return undefined;
    const timer = window.setTimeout(() => {
      const rect = viewRef.current?.getBoundingClientRect();
      if (!rect?.width || !rect?.height) return;
      // 视觉参数：默认缩放留边，尽量在小窗口里看完整技能树。
      const fit = Math.max(LESSON_SKILL_MIN_ZOOM, Math.min(1, (rect.width - 20) / width, (rect.height - 20) / height));
      setZoom(fit);
      setPan({ x: 10, y: 10 });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [height, skills.length, width]);

  useEffect(() => {
    if (!drag) return undefined;
    function handleMove(event) {
      setPan({ x: drag.px + event.clientX - drag.sx, y: drag.py + event.clientY - drag.sy });
    }
    function handleUp() {
      setDrag(null);
    }
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
    };
  }, [drag]);

  function setTarget(skill, star) {
    if (!hasLessonSkillStars(skill)) return;
    if (star <= Number(skill.currentStars || 0)) return;
    const key = targetKey(skill.skillId, star);
    const nextTargets = targetSet.has(key)
      ? targets.filter((target) => targetKey(target.skillId, target.targetStar) !== key)
      : [...targets, { skillId: skill.skillId, name: skill.name, targetStar: star }];
    onChange({ ...plan, target_skills: nextTargets });
  }

  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div style={{ display: "flex", gap: 6, justifyContent: "center", alignItems: "center" }}>
        <button type="button" style={{ ...buttonStyle, height: 24, padding: "0 8px", fontSize: 11 }} onClick={() => setZoom((value) => Math.max(LESSON_SKILL_MIN_ZOOM, value - 0.1))}>-</button>
        <span style={{ fontSize: 12, color: "#64748b", minWidth: 42, textAlign: "center" }}>{Math.round(zoom * 100)}%</span>
        <button type="button" style={{ ...buttonStyle, height: 24, padding: "0 8px", fontSize: 11 }} onClick={() => setZoom((value) => Math.min(1.8, value + 0.1))}>+</button>
        <button type="button" style={{ ...buttonStyle, height: 24, padding: "0 8px", fontSize: 11 }} onClick={() => { setZoom(0.8); setPan({ x: 10, y: 10 }); }}>重置</button>
      </div>
      <div
        ref={viewRef}
        style={{ height: LESSON_SKILL_TREE_H, border: "1px solid #e5e7eb", borderRadius: 12, background: "#f8fafc", overflow: "hidden", position: "relative", cursor: drag ? "grabbing" : "grab", userSelect: "none", WebkitUserSelect: "none", touchAction: "none" }}
        onPointerDown={(event) => {
          if (event.target.closest("button")) return;
          setDrag({ sx: event.clientX, sy: event.clientY, px: pan.x, py: pan.y });
        }}
      >
      {skills.length === 0 && <div style={{ color: "#94a3b8", fontSize: 13, padding: 12 }}>暂无技能树，先去技能树管理页导入或创建技能点。</div>}
      {skills.length > 0 && (
        <div style={{ position: "absolute", left: 0, top: 0, width, height, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: "top left" }}>
          <svg width={width} height={height} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
            {skills.filter((skill) => skill.parentId).map((skill) => {
              const parent = layout.get(skill.parentId);
              const child = layout.get(skill.skillId);
              if (!parent || !child) return null;
              const x1 = parent.x + LESSON_SKILL_NODE_W;
              const y1 = parent.y + LESSON_SKILL_NODE_H / 2;
              const x2 = child.x;
              const y2 = child.y + LESSON_SKILL_NODE_H / 2;
              const midX = x1 + Math.max(24, (x2 - x1) / 2);
              return <path key={`${skill.parentId}-${skill.skillId}`} d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`} fill="none" stroke="#cbd5e1" strokeWidth="1.5" />;
            })}
          </svg>
          {skills.map((skill) => {
            const pos = layout.get(skill.skillId);
            if (!pos) return null;
            const canScore = hasLessonSkillStars(skill);
            return (
              <div key={skill.skillId} style={{ position: "absolute", left: pos.x, top: pos.y, width: LESSON_SKILL_NODE_W, height: LESSON_SKILL_NODE_H, border: skill.parentId ? "1px solid #d4d4d8" : "2px solid #93c5fd", borderRadius: 10, background: "#fff", padding: "8px 10px", boxSizing: "border-box", display: "grid", gridTemplateRows: canScore ? "22px 24px" : "1fr", alignContent: "center", gap: 6 }}>
                <span style={{ fontSize: 12, lineHeight: "22px", fontWeight: 900, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{skill.name}</span>
                {canScore && <span style={{ display: "flex", gap: 3, alignItems: "center", height: 24 }}>
                  {[1, 2, 3, 4, 5].map((star) => {
                    const mastered = star <= Number(skill.currentStars || 0);
                    const targeted = targetSet.has(targetKey(skill.skillId, star));
                    return (
                      <button
                        key={star}
                        type="button"
                        title={mastered ? "已掌握" : targeted ? "目标星星" : "设为目标"}
                        onClick={() => setTarget(skill, star)}
                        style={{ border: "none", background: targeted ? "#dbeafe" : "transparent", borderRadius: 6, color: mastered ? "#facc15" : targeted ? "#2563eb" : "#d4d4d8", cursor: mastered ? "default" : "pointer", fontSize: 15, lineHeight: "22px", width: 21, height: 22, padding: 0 }}
                      >
                        {"\u2605"}
                      </button>
                    );
                  })}
                </span>}
              </div>
            );
          })}
        </div>
      )}
      </div>
    </div>
  );
}

function clampActionMinute(value, task) {
  const start = Number(task.startMin || 0);
  const end = Number(task.endMin || start);
  return Math.max(start, Math.min(end, Number(value || start)));
}

function UnifiedTimelineEditor({ items, onChange }) {
  const idRef = useRef(0);
  function patch(index, patchValue) {
    onChange(items.map((item, itemIndex) => {
      if (itemIndex !== index) return item;
      const next = { ...item, ...patchValue };
      if (patchValue.startMin !== undefined || patchValue.endMin !== undefined) {
        next.coachActions = (next.coachActions || []).map((action) => ({
          ...action,
          minute: clampActionMinute(action.minute, next),
        }));
      }
      return next;
    }));
  }
  function addTask() {
    idRef.current += 1;
    onChange([
      ...items,
      { id: `stage-manual-${idRef.current}`, startMin: 0, endMin: 5, phase: "专项练习", content: "新训练内容", note: "", coachActions: [] },
    ]);
  }
  function addCoachAction(taskIndex) {
    const task = items[taskIndex];
    idRef.current += 1;
    patch(taskIndex, {
      coachActions: [
        ...(task.coachActions || []),
        { id: `coach-manual-${idRef.current}`, minute: Number(task.startMin || 0), action: "观察", priority: "normal" },
      ],
    });
  }
  function patchCoachAction(taskIndex, actionIndex, patchValue) {
    const task = items[taskIndex];
    const nextActions = (task.coachActions || []).map((action, itemIndex) => {
      if (itemIndex !== actionIndex) return action;
      const next = { ...action, ...patchValue };
      if (patchValue.minute !== undefined) next.minute = clampActionMinute(patchValue.minute, task);
      return next;
    });
    patch(taskIndex, { coachActions: nextActions });
  }
  function removeCoachAction(taskIndex, actionIndex) {
    const task = items[taskIndex];
    patch(taskIndex, { coachActions: (task.coachActions || []).filter((_, itemIndex) => itemIndex !== actionIndex) });
  }
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
        <strong>课堂时间轴</strong>
        <button type="button" style={{ ...buttonStyle, height: 28, padding: "0 8px", fontSize: 12 }} onClick={addTask}>添加训练任务</button>
      </div>
      <div style={{ maxHeight: LESSON_TIMELINE_H, overflowY: "auto", display: "grid", gap: 8, paddingRight: 2 }}>
        {items.length === 0 && <div style={{ color: "#94a3b8", fontSize: 13 }}>暂无时间轴内容，点击 AI 生成或手动添加。</div>}
        {items.map((item, index) => (
          <div key={item.id || index} style={{ borderLeft: "4px solid #16a34a", background: "#f8fafc", borderRadius: 10, padding: 10, display: "grid", gap: 8 }}>
            <div style={{ display: "grid", gridTemplateColumns: "60px 60px minmax(120px,1fr) 34px", gap: 6 }}>
              <input type="number" value={item.startMin ?? 0} onChange={(event) => patch(index, { startMin: Number(event.target.value) })} style={{ ...inputStyle, height: 32, fontSize: 12 }} />
              <input type="number" value={item.endMin ?? 0} onChange={(event) => patch(index, { endMin: Number(event.target.value) })} style={{ ...inputStyle, height: 32, fontSize: 12 }} />
              <input value={item.phase || ""} onChange={(event) => patch(index, { phase: event.target.value })} style={{ ...inputStyle, height: 32, fontSize: 12 }} />
              <button type="button" aria-label="删除训练任务" style={{ ...buttonStyle, height: 32, padding: 0 }} onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))}>{"\u00d7"}</button>
            </div>
            <input value={item.content || ""} onChange={(event) => patch(index, { content: event.target.value })} style={{ ...inputStyle, height: 32, fontSize: 12 }} />
            <input value={item.note || ""} onChange={(event) => patch(index, { note: event.target.value })} placeholder="备注" style={{ ...inputStyle, height: 32, fontSize: 12 }} />
            <div style={{ display: "grid", gap: 6, borderLeft: "4px solid #f59e0b", paddingLeft: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12, color: "#92400e", fontWeight: 900 }}>教练动作</span>
                <button type="button" style={{ ...buttonStyle, height: 26, padding: "0 8px", fontSize: 12 }} onClick={() => addCoachAction(index)}>+</button>
              </div>
              {(item.coachActions || []).map((action, actionIndex) => (
                <div key={action.id || actionIndex} style={{ display: "grid", gridTemplateColumns: "64px 88px 34px", gap: 6 }}>
                  <input
                    type="number"
                    min={Number(item.startMin || 0)}
                    max={Number(item.endMin || item.startMin || 0)}
                    value={action.minute ?? item.startMin ?? 0}
                    onChange={(event) => patchCoachAction(index, actionIndex, { minute: Number(event.target.value) })}
                    style={{ ...inputStyle, height: 30, fontSize: 12, borderColor: "#f59e0b" }}
                  />
                  <select value={action.action || "观察"} onChange={(event) => patchCoachAction(index, actionIndex, { action: event.target.value })} style={{ ...inputStyle, height: 30, fontSize: 12, borderColor: "#f59e0b" }}>
                    {lessonActionOptions.map((option) => <option key={option} value={option}>{option}</option>)}
                  </select>
                  <button type="button" aria-label="删除教练动作" style={{ ...buttonStyle, height: 30, padding: 0 }} onClick={() => removeCoachAction(index, actionIndex)}>{"\u00d7"}</button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LessonPlanCard({ eventId, participant, onChange, onSave, onAi }) {
  const plan = normalizePanelPlan(eventId, participant);
  const targets = plan.target_skills || [];
  const stages = Array.isArray(plan.training_tasks) ? plan.training_tasks : [];
  const [aiText, setAiText] = useState("");
  const [aiStatus, setAiStatus] = useState("");
  const [aiUsage, setAiUsage] = useState({ optimizeCount: 0, optimizeLimit: 3 });

  function patchPlan(patch) {
    onChange(participant.pilotId, { ...plan, ...patch });
  }

  async function runAi(regenerate = false) {
    const instruction = aiText.trim();
    if (!regenerate && !instruction) {
      setAiStatus("请输入要优化的要求");
      return;
    }
    if (!regenerate && aiUsage.optimizeCount >= aiUsage.optimizeLimit) {
      setAiStatus(`单人优化最多 ${aiUsage.optimizeLimit} 次，请直接手动编辑或重新生成`);
      return;
    }
    setAiStatus(regenerate ? "正在重新生成..." : "正在继续优化...");
    try {
      const result = await onAi(participant.pilotId, { instruction, regenerate });
      setAiUsage({
        optimizeCount: Number(result?.session?.optimizeCount ?? result?.log?.optimizeCount ?? aiUsage.optimizeCount),
        optimizeLimit: Number(result?.log?.optimizeLimit || aiUsage.optimizeLimit),
      });
      setAiText("");
      setAiStatus(`已更新，耗时 ${result?.log?.durationMs || 0}ms，输入 ${result?.log?.inputChars || 0} 字，输出 ${result?.log?.outputChars || 0} 字`);
    } catch (error) {
      setAiStatus(`AI 失败：${error.message}`);
    }
  }

  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, background: "#fff", display: "grid", gap: 12, minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "start" }}>
        <div style={{ minWidth: 0 }}>
          <strong style={{ display: "block", color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{participant.pilotName}</strong>
          <div style={{ color: "#64748b", fontSize: 12, marginTop: 3 }}>
            {quadrantText(participant.stratification?.quadrant)} · 权重 {Number(participant.stratification?.attention_weight || 0).toFixed(2)}
          </div>
        </div>
        <button type="button" style={{ ...buttonStyle, height: 30, padding: "0 10px", fontSize: 12 }} onClick={() => onSave(participant.pilotId)}>保存</button>
      </div>

      <LessonSkillMindMap participant={participant} plan={plan} onChange={(nextPlan) => onChange(participant.pilotId, nextPlan)} />

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {targets.length === 0 && <span style={{ color: "#94a3b8", fontSize: 12 }}>未选择目标星星。</span>}
        {targets.map((target) => (
          <span key={targetKey(target.skillId, target.targetStar)} style={{ border: "1px solid #facc15", background: "#fef9c3", borderRadius: 999, padding: "4px 8px", fontSize: 12, color: "#854d0e" }}>
            {target.name} 目标 {target.targetStar} 星
          </span>
        ))}
      </div>

      <UnifiedTimelineEditor items={stages} onChange={(next) => patchPlan({ training_tasks: next })} />
      <textarea value={plan.ai_suggestion || ""} onChange={(event) => patchPlan({ ai_suggestion: event.target.value })} placeholder="备课建议" style={{ ...inputStyle, minHeight: 58, height: 58, padding: 8, fontSize: 12, resize: "vertical" }} />
      <div style={{ display: "grid", gap: 6, borderTop: "1px solid #e5e7eb", paddingTop: 10 }}>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(160px,1fr) auto auto", gap: 6 }}>
          <input value={aiText} onChange={(event) => setAiText(event.target.value)} placeholder="优化提示词" style={{ ...inputStyle, height: 32, fontSize: 12 }} />
          <button type="button" style={{ ...buttonStyle, height: 32, padding: "0 8px", fontSize: 12 }} onClick={() => runAi(false)}>继续优化</button>
          <button type="button" style={{ ...primaryButtonStyle, height: 32, padding: "0 8px", fontSize: 12 }} onClick={() => runAi(true)}>重新生成</button>
        </div>
        {aiStatus && <div style={{ fontSize: 12, color: aiStatus.includes("失败") ? "#b91c1c" : "#047857" }}>{aiStatus}</div>}
        <div style={{ color: "#64748b", fontSize: 12 }}>本学员已优化 {aiUsage.optimizeCount}/{aiUsage.optimizeLimit} 次。</div>
      </div>
    </div>
  );
}

function escapePrintHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function printPageShell(title, body) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapePrintHtml(title)}</title>
<style>
@page{size:A4;margin:14mm}
*{box-sizing:border-box}
body{margin:0;background:#e5e7eb;color:#0f172a;font-family:Arial,"Microsoft YaHei",sans-serif;font-size:12px;line-height:1.55}
.no-print{position:fixed;right:18px;top:18px;z-index:10;border:1px solid #cbd5e1;background:#fff;border-radius:8px;padding:8px 14px;font-weight:900;cursor:pointer}
.page{width:210mm;min-height:297mm;margin:18px auto;background:#fff;padding:18mm;box-shadow:0 18px 50px rgba(15,23,42,.18)}
.header{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;border-bottom:2px solid #0f172a;padding-bottom:12px;margin-bottom:14px}
h1{font-size:25px;line-height:1.2;margin:0;font-weight:950;letter-spacing:0}
.subtitle{color:#64748b;margin-top:6px}
.meta{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0}
.metric{border:1px solid #e2e8f0;background:#f8fafc;border-radius:8px;padding:8px}.metric b{display:block;font-size:16px;color:#0f172a}.metric span{color:#64748b}
.section-title{font-size:14px;font-weight:950;margin:16px 0 8px;color:#0f172a}
.pills{display:flex;gap:6px;flex-wrap:wrap}.pill{border:1px solid #facc15;background:#fef9c3;color:#854d0e;border-radius:999px;padding:4px 9px;font-weight:800}
.tree-wrap{border:1px solid #e2e8f0;border-radius:10px;background:#f8fafc;padding:8px;overflow:hidden}
.tree-wrap svg{display:block;width:100%;height:auto}
.task{break-inside:avoid;border:1px solid #e2e8f0;border-left:5px solid #16a34a;border-radius:8px;padding:10px 12px;margin:8px 0;background:#fff}
.task-head{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:6px}.time{font-weight:950;color:#15803d}.phase{font-weight:950;color:#0f172a}
.note{color:#94a3b8;margin-top:4px}
.muted{color:#64748b}.small{font-size:11px}.focus{border-left:3px solid #f59e0b;padding-left:8px;margin-top:6px;color:#92400e}
table{width:100%;border-collapse:collapse;font-size:11px}th,td{border-bottom:1px solid #e2e8f0;padding:7px 6px;text-align:left;vertical-align:top}th{background:#f8fafc;color:#334155;font-weight:950}
@media print{body{background:#fff}.no-print{display:none}.page{width:auto;min-height:auto;margin:0;padding:0;box-shadow:none}.task{page-break-inside:avoid}}
</style></head><body><button class="no-print" onclick="window.print()">打印 A4</button><main class="page">${body}</main></body></html>`;
}

function openPrintPage(title, body) {
  const win = window.open("", "_blank");
  if (!win) return;
  win.document.open();
  win.document.write(printPageShell(title, body));
  win.document.close();
  win.setTimeout(() => {
    win.focus();
    win.print();
  }, 250);
}

function participantFrequencyText(participant) {
  if (participant.videoChannel) return participant.videoChannel;
  return participant.videoBand && participant.videoNumber ? `${participant.videoBand}${participant.videoNumber}` : "";
}

function participantLabel(participant) {
  const frequency = participantFrequencyText(participant);
  return frequency ? `${participant.pilotName} ${frequency}` : participant.pilotName;
}

function renderPrintSkillTree(participant, plan) {
  const skills = participant.skills || [];
  if (!skills.length) return '<div class="muted">暂无技能树</div>';
  const { layout, width, height } = buildLessonSkillLayout(skills);
  const targets = plan.target_skills || [];
  const targetSet = new Set(targets.map((target) => targetKey(target.skillId, target.targetStar)));
  const svgWidth = width + 24;
  const svgHeight = height + 24;
  const lines = skills.filter((skill) => skill.parentId).map((skill) => {
    const parent = layout.get(skill.parentId);
    const child = layout.get(skill.skillId);
    if (!parent || !child) return "";
    const x1 = parent.x + LESSON_SKILL_NODE_W + 12;
    const y1 = parent.y + LESSON_SKILL_NODE_H / 2 + 12;
    const x2 = child.x + 12;
    const y2 = child.y + LESSON_SKILL_NODE_H / 2 + 12;
    const midX = x1 + Math.max(24, (x2 - x1) / 2);
    return `<path d="M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}" fill="none" stroke="#cbd5e1" stroke-width="1.5"/>`;
  }).join("");
  const nodes = skills.map((skill) => {
    const pos = layout.get(skill.skillId);
    if (!pos) return "";
    const x = pos.x + 12;
    const y = pos.y + 12;
    const title = escapePrintHtml(String(skill.name || "").slice(0, 11));
    const stars = hasLessonSkillStars(skill) ? [1, 2, 3, 4, 5].map((star) => {
      const mastered = star <= Number(skill.currentStars || 0);
      const targeted = targetSet.has(targetKey(skill.skillId, star));
      const color = targeted ? "#2563eb" : mastered ? "#facc15" : "#cbd5e1";
      const bg = targeted ? `<rect x="${x + 8 + (star - 1) * 23}" y="${y + 32}" width="20" height="20" rx="5" fill="#dbeafe"/>` : "";
      return `${bg}<text x="${x + 18 + (star - 1) * 23}" y="${y + 47}" text-anchor="middle" font-size="15" fill="${color}">★</text>`;
    }).join("") : "";
    return `<g><rect x="${x}" y="${y}" width="${LESSON_SKILL_NODE_W}" height="${LESSON_SKILL_NODE_H}" rx="8" fill="#fff" stroke="${skill.parentId ? "#d4d4d8" : "#93c5fd"}" stroke-width="${skill.parentId ? 1 : 2}"/><text x="${x + 10}" y="${y + 22}" font-size="12" font-weight="800" fill="#0f172a">${title}</text>${stars}</g>`;
  }).join("");
  return `<div class="tree-wrap"><svg viewBox="0 0 ${svgWidth} ${svgHeight}" role="img" aria-label="技能树">${lines}${nodes}</svg></div>`;
}

function renderTargetCriteria(participant, plan) {
  const skills = participant.skills || [];
  const skillMap = new Map(skills.map((skill) => [skill.skillId, skill]));
  const targets = (plan.target_skills || [])
    .map((target) => {
      const skill = skillMap.get(target.skillId);
      if (!skill || !hasLessonSkillStars(skill)) return null;
      return {
        name: target.name || skill.name,
        star: Number(target.targetStar || 0),
        criterion: lessonStarCriterion(skill, target.targetStar),
      };
    })
    .filter(Boolean);
  if (!targets.length) return '<div class="muted">暂无目标星级标准</div>';
  return `<table><thead><tr><th>技能</th><th>目标星级</th><th>标准</th></tr></thead><tbody>${targets.map((target) => `<tr><td>${escapePrintHtml(target.name)}</td><td>${escapePrintHtml(target.star)} 星</td><td>${escapePrintHtml(target.criterion || "暂无标准")}</td></tr>`).join("")}</tbody></table>`;
}

function StudentLessonPage({ participants, track }) {
  function openStudentPlan(participant) {
    const plan = participant.plan || {};
    const targets = plan.target_skills || [];
    const tasks = plan.training_tasks || [];
    const frequency = participantFrequencyText(participant);
    const title = `${participant.pilotName}  学案`;
    const body = `
<div class="header"><div><h1>${escapePrintHtml(participant.pilotName)}${frequency ? ` <span style="color:#2563eb;">${escapePrintHtml(frequency)}</span>` : ""} 学案</h1></div>
<div class="muted small">${new Date().toLocaleDateString("zh-CN")}</div>
</div>${track?.trackImageUrl ? `<div class="section-title">🏁 训练赛道图</div><img src="${escapePrintHtml(track.trackImageUrl)}" alt="当前训练赛道图" style="width:100%;max-height:220px;object-fit:contain;border:1px solid #e2e8f0;border-radius:10px;background:#f8fafc;padding:6px">` : ""}
<div class="section-title">🗺️ 技能树</div>${renderPrintSkillTree(participant, plan)}
<div class="section-title">目标星级标准</div>${renderTargetCriteria(participant, plan)}
<div class="section-title">🎯 目标星数 ${targets.length}⭐</div>
<div class="pills">${targets.length ? targets.map((target) => `<span class="pill">${escapePrintHtml(target.name)}：${"⭐".repeat(Math.max(1, Math.min(5, Number(target.targetStar || 1))))} ${escapePrintHtml(target.targetStar)}星级</span>`).join("") : '<span class="muted">暂无目标星级</span>'}</div>
<div class="section-title">📋 课堂时间轴</div>
${tasks.length ? tasks.map((task) => `<section class="task"><div class="task-head"><span class="phase">${escapePrintHtml(task.phase || "训练任务")}</span><span class="time">${escapePrintHtml(task.startMin)}-${escapePrintHtml(task.endMin)} min</span></div><div>${escapePrintHtml(task.content || "")}</div>${task.note ? `<div class="note">${escapePrintHtml(task.note)}</div>` : ""}</section>`).join("") : '<div class="muted">暂无训练任务</div>'}`;
    openPrintPage(title, body);
  }

  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, background: "#fff", display: "flex", gap: 8, flexWrap: "wrap" }}>
      {participants.map((participant) => {
        return (
          <button key={participant.pilotId} type="button" style={primaryButtonStyle} onClick={() => openStudentPlan(participant)}>
            生成 {participant.pilotName} 学案页面
          </button>
        );
      })}
    </div>
  );
}

// eslint-disable-next-line no-unused-vars
function CoachTaskPage({ participants }) {
  const actions = participants
    .flatMap((participant) => (participant.plan?.training_tasks || []).flatMap((task) => (
      (task.coachActions || []).map((action) => ({
        ...action,
        pilotName: participant.pilotName,
        taskPhase: task.phase,
        taskContent: task.content,
      }))
    )))
    .sort((left, right) => Number(left.minute || 0) - Number(right.minute || 0));
  const heavyPilots = participants
    .filter((participant) => Number(participant.stratification?.attention_weight || 0) >= 0.3)
    .map((participant) => participant.pilotName);
  function openCoachTasks() {
    const body = `
<div class="header"><div><h1>教练任务单</h1><div class="subtitle">按时间执行讲解、观察、修正、验收等</div></div><div class="muted small">${new Date().toLocaleDateString("zh-CN")}</div></div>
<div class="meta"><div class="metric"><span>任务数</span><b>${actions.length}</b></div><div class="metric"><span>学员数</span><b>${participants.length}</b></div><div class="metric"><span>重点关注</span><b>${heavyPilots.length}</b></div></div>
<div class="section-title">课堂注意力节奏</div>
<div class="task"><div>重点关注：${escapePrintHtml(heavyPilots.join("、") || "暂无高权重学员")}。按时间轴穿插讲解、观察、修正、验收。</div></div>
<div class="section-title">教练动作清单</div>
${actions.length ? `<table><thead><tr><th style="width:15%">时间</th><th style="width:16%">学员</th><th style="width:14%">动作</th><th>任务与关注点</th></tr></thead><tbody>${actions.map((action) => `<tr><td><b>${escapePrintHtml(action.minute)} min</b></td><td>${escapePrintHtml(action.pilotName)}</td><td>${escapePrintHtml(action.action)}</td><td><b>${escapePrintHtml(action.taskPhase || "")}</b>${action.taskContent ? `：${escapePrintHtml(action.taskContent)}` : ""}${action.focus ? `<div class="focus">${escapePrintHtml(action.focus)}</div>` : ""}</td></tr>`).join("")}</tbody></table>` : '<div class="muted">暂无教练动作，请先生成方案。</div>'}`;
    openPrintPage("教练任务单", body);
  }
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, background: "#fff", display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div>
          <strong>课堂注意力节奏</strong>
          <div style={{ color: "#64748b", fontSize: 13, marginTop: 6 }}>重点关注：{heavyPilots.join("、") || "暂无高权重学员"}。按时间轴穿插讲解、观察、修正、验收。</div>
        </div>
        <button type="button" style={primaryButtonStyle} onClick={openCoachTasks}>生成教练任务单</button>
      </div>
      <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, background: "#fff", display: "grid", gap: 8 }}>
        {actions.length === 0 && <div style={{ color: "#94a3b8", fontSize: 13 }}>暂无教练动作，请先生成方案。</div>}
        {actions.map((action, index) => (
          <div key={`${action.minute}-${action.pilotName}-${index}`} style={{ display: "grid", gridTemplateColumns: "70px 90px 72px minmax(0,1fr)", gap: 8, alignItems: "center", borderLeft: "3px solid #f59e0b", paddingLeft: 10 }}>
            <strong>{action.minute}min</strong>
            <span>{action.pilotName}</span>
            <span style={{ color: "#b45309", fontWeight: 900 }}>{action.action}</span>
            <span style={{ color: "#334155", fontSize: 13 }}>{action.taskPhase}：{action.taskContent}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CoachTaskEditorPage({ eventId, participants }) {
  const [draft, setDraft] = useState(() => ({
    minute: 0,
    action: "自定义",
    priority: "normal",
    focus: "",
  }));
  const [customActions, setCustomActions] = useState([]);
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (!eventId) return undefined;
    let stopped = false;
    async function loadCustomActions() {
      const payload = await coachGet(`/api/training-events/${encodeURIComponent(eventId)}/coach-tasks`);
      if (!stopped) setCustomActions((payload.tasks || []).filter((task) => task.source === "user_custom" && !task.pilotId));
    }
    loadCustomActions().catch((error) => {
      if (!stopped) setStatus(`读取自定义任务失败：${error.message}`);
    });
    return () => {
      stopped = true;
    };
  }, [eventId]);

  const lessonActions = participants
    .flatMap((participant) => (participant.plan?.training_tasks || []).flatMap((task, stageIndex) => (
      (task.coachActions || []).map((action, actionIndex) => ({
        ...action,
        stageIndex,
        actionIndex,
        pilotId: participant.pilotId,
        pilotName: participant.pilotName,
        pilotDisplayName: participantLabel(participant),
        taskPhase: task.phase,
        taskContent: task.content,
        source: action.source || task.source || "",
      }))
    )));
  const actions = [
    ...lessonActions,
    ...customActions.map((action) => ({
      ...action,
      pilotId: "",
      pilotName: "全局任务",
      pilotDisplayName: "全局任务",
      taskPhase: "自定义任务",
      taskContent: action.focus || "",
      source: "user_custom",
    })),
  ]
    .sort((left, right) => Number(left.minute || 0) - Number(right.minute || 0));
  const heavyPilots = participants
    .filter((participant) => Number(participant.stratification?.attention_weight || 0) >= 0.3)
    .map((participant) => participant.pilotName);

  async function addCustomAction() {
    const minute = Math.max(0, Math.floor(Number(draft.minute || 0)));
    const focus = String(draft.focus || "").trim() || "自定义任务";
    setStatus("正在保存自定义任务...");
    try {
      const payload = await coachPost(`/api/teaching/events/${encodeURIComponent(eventId)}/coach-custom-actions`, {
        minute,
        action: draft.action || "自定义",
        priority: draft.priority || "normal",
        focus,
      });
      setCustomActions((payload.tasks || []).filter((task) => task.source === "user_custom" && !task.pilotId));
      setDraft((current) => ({ ...current, focus: "" }));
      setStatus("已添加自定义任务");
    } catch (error) {
      setStatus(`保存失败：${error.message}`);
    }
  }

  async function removeCustomAction(action) {
    if (action.source !== "user_custom") return;
    setStatus("正在删除自定义任务...");
    try {
      const payload = await coachDelete(`/api/teaching/events/${encodeURIComponent(eventId)}/coach-custom-actions/${encodeURIComponent(action.id)}`);
      setCustomActions((payload.tasks || []).filter((task) => task.source === "user_custom" && !task.pilotId));
      setStatus("已删除自定义任务");
    } catch (error) {
      setStatus(`删除失败：${error.message}`);
    }
  }

  function openCoachTasks() {
    const body = `
<div class="header"><div><h1>教练任务单</h1><div class="subtitle">按时间执行讲解、观察、修正、验收</div></div><div class="muted small">${new Date().toLocaleString("zh-CN")}</div></div>
<div class="meta"><div class="metric"><span>任务数</span><b>${actions.length}</b></div><div class="metric"><span>学员数</span><b>${participants.length}</b></div><div class="metric"><span>重点关注</span><b>${heavyPilots.length}</b></div></div>
<div class="section-title">课堂注意力节奏</div>
<div class="task"><div>重点关注：${escapePrintHtml(heavyPilots.join("、") || "暂无高权重学员")}。按时间轴穿插讲解、观察、修正、验收。</div></div>
<div class="section-title">教练动作清单</div>
${actions.length ? `<table><thead><tr><th style="width:15%">时间</th><th style="width:16%">学员</th><th style="width:14%">动作</th><th>任务与关注点</th></tr></thead><tbody>${actions.map((action) => `<tr><td><b>${escapePrintHtml(action.minute)} min</b></td><td${action.pilotDisplayName === "全局任务" ? ' style="color:#2563eb;font-weight:800;"' : ""}>${escapePrintHtml(action.pilotDisplayName || action.pilotName)}</td><td>${escapePrintHtml(action.action)}</td><td>${action.source === "user_custom" ? escapePrintHtml(action.focus || action.taskContent || "") : `<b>${escapePrintHtml(action.taskPhase || "")}</b>${action.taskContent ? `：${escapePrintHtml(action.taskContent)}` : ""}${action.focus ? `<div class="focus">${escapePrintHtml(action.focus)}</div>` : ""}`}</td></tr>`).join("")}</tbody></table>` : '<div class="muted">暂无教练动作，请先生成方案。</div>'}`;
    openPrintPage("教练任务单", body);
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, background: "#fff", display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div>
          <strong>课堂注意力节奏</strong>
          <div style={{ color: "#64748b", fontSize: 13, marginTop: 6 }}>重点关注：{heavyPilots.join("、") || "暂无高权重学员"}。按时间轴穿插讲解、观察、修正、验收。</div>
          {status && <div style={{ color: status.includes("失败") ? "#b91c1c" : "#047857", fontSize: 13, marginTop: 6 }}>{status}</div>}
        </div>
        <button type="button" style={primaryButtonStyle} onClick={openCoachTasks}>生成教练任务单</button>
      </div>

      <div style={{ border: "1px solid #bfdbfe", borderRadius: 12, padding: 12, background: "#eff6ff", display: "grid", gap: 10 }}>
        <strong style={{ color: "#1d4ed8" }}>添加教练动作</strong>
        <div style={{ display: "grid", gridTemplateColumns: "110px 88px 110px 110px minmax(180px,2fr) auto", gap: 8, alignItems: "center" }}>
          <div style={{ ...inputStyle, height: 34, display: "flex", alignItems: "center", justifyContent: "center", color: "#1d4ed8", fontWeight: 900, fontSize: 14 }}>全局任务</div>
          <input type="number" min="0" value={draft.minute} onChange={(event) => setDraft((current) => ({ ...current, minute: Number(event.target.value) }))} style={{ ...inputStyle, height: 34 }} />
          <input value={draft.action} onChange={(event) => setDraft((current) => ({ ...current, action: event.target.value }))} placeholder="布置赛道/开门" style={{ ...inputStyle, height: 34 }} />
          <select value={draft.priority} onChange={(event) => setDraft((current) => ({ ...current, priority: event.target.value }))} style={{ ...inputStyle, height: 34 }}>
            <option value="normal">普通</option>
            <option value="high">高优先级</option>
            <option value="low">低优先级</option>
          </select>
          <input value={draft.focus} onChange={(event) => setDraft((current) => ({ ...current, focus: event.target.value }))} placeholder="任务内容/关注点" style={{ ...inputStyle, height: 34 }} />
          <button type="button" style={{ ...primaryButtonStyle, height: 34, padding: "0 12px" }} onClick={addCustomAction}>添加并保存</button>
        </div>
      </div>

      <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, background: "#fff", display: "grid", gap: 8 }}>
        {actions.length === 0 && <div style={{ color: "#94a3b8", fontSize: 13 }}>暂无教练动作，请先生成方案。</div>}
        {actions.map((action, index) => {
          const custom = action.source === "user_custom";
          return (
            <div key={`${action.minute}-${action.pilotName}-${index}`} style={{ display: "grid", gridTemplateColumns: "70px 90px 92px minmax(0,1fr) auto", gap: 8, alignItems: "center", borderLeft: `3px solid ${custom ? "#2563eb" : "#f59e0b"}`, background: custom ? "#eff6ff" : "#fff", borderRadius: 8, padding: "8px 10px" }}>
              <strong>{action.minute}min</strong>
              <span>{action.pilotDisplayName || action.pilotName}</span>
              <span style={{ color: custom ? "#1d4ed8" : "#b45309", fontWeight: 900 }}>{action.action}</span>
              <span style={{ color: "#334155", fontSize: 13, overflowWrap: "anywhere" }}>{custom ? (action.focus || action.taskContent || "") : `${action.taskPhase}${action.taskContent ? `：${action.taskContent}` : ""}${action.focus ? `｜${action.focus}` : ""}`}</span>
              {custom ? <button type="button" style={{ ...buttonStyle, height: 30, padding: "0 10px", fontSize: 12 }} onClick={() => removeCustomAction(action)}>删除</button> : <span />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PrecipBarChart({ title, items, emptyText }) {
  const values = (items || []).map((item) => Number(item.precip || 0));
  const maxValue = Math.max(0.1, ...values);
  const ticks = [maxValue, maxValue / 2, 0];
  return (
    <div style={{ border: "1px solid #dbeafe", borderRadius: 10, background: "#fff", padding: 10, display: "grid", gap: 8 }}>
      <strong style={{ color: "#0f172a", fontSize: 13 }}>{title}</strong>
      {items?.length ? (
        <div style={{ display: "grid", gridTemplateColumns: "42px minmax(0,1fr)", gridTemplateRows: "92px 18px", gap: "4px 8px", minWidth: 0 }}>
          <div style={{ gridColumn: 1, gridRow: 1, position: "relative", color: "#64748b", fontSize: 10 }}>
            {ticks.map((tick, index) => (
              <span key={index} style={{ position: "absolute", right: 0, top: index === 0 ? 0 : index === 1 ? "calc(50% - 6px)" : "calc(100% - 12px)" }}>
                {tick.toFixed(tick >= 1 ? 1 : 2)}
              </span>
            ))}
          </div>
          <div style={{ gridColumn: 2, gridRow: 1, position: "relative", minWidth: 0 }}>
            {[0, 0.5, 1].map((ratio) => (
              <div key={ratio} style={{ position: "absolute", left: 0, right: 0, top: `${ratio * 100}%`, borderTop: "1px solid #e2e8f0" }} />
            ))}
            <div style={{ position: "relative", height: "100%", display: "flex", gap: 3, alignItems: "end", minWidth: 0 }}>
              {items.map((item) => {
                const precip = Number(item.precip || 0);
                const height = Math.max(3, Math.round((precip / maxValue) * 84));
                return (
                  <div key={`${item.time}-${item.pop ?? ""}`} title={`${item.time} 降水 ${precip}mm，概率 ${item.pop ?? 0}%`} style={{ flex: "1 1 0", minWidth: 0, height: "100%", display: "flex", alignItems: "end", justifyContent: "center" }}>
                    <div style={{ width: "70%", maxWidth: 18, minWidth: 4, height, borderRadius: "5px 5px 0 0", background: precip > 0 ? "#2563eb" : "#cbd5e1" }} />
                  </div>
                );
              })}
            </div>
          </div>
          <div style={{ gridColumn: 2, gridRow: 2, display: "flex", gap: 3, minWidth: 0 }}>
            {items.map((item, index) => (
              <div key={`${item.time}-${index}`} style={{ flex: "1 1 0", minWidth: 0, textAlign: "center", color: "#64748b", fontSize: 10, overflow: "hidden" }}>
                <span style={{ display: index % 2 === 0 || items.length <= 12 ? "inline" : "none" }}>{item.time}</span>
              </div>
            ))}
          </div>
          <div style={{ gridColumn: 1, gridRow: 2, color: "#64748b", fontSize: 10, textAlign: "right" }}>mm</div>
        </div>
      ) : (
        <div style={{ color: "#64748b", fontSize: 13 }}>{emptyText}</div>
      )}
    </div>
  );
}

function LessonPlanPanel({ event }) {
  const [unlocked, setUnlocked] = useState(false);
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState("");
  const [payload, setPayload] = useState(null);
  const [viewMode, setViewMode] = useState("edit");
  const [aiSystemPrompt, setAiSystemPrompt] = useState("");
  const [teachingMaterial, setTeachingMaterial] = useState("");
  const [extraTeachingMaterial, setExtraTeachingMaterial] = useState("");
  const [teachingMethodManual, setTeachingMethodManual] = useState("");
  const [budgetConfigText, setBudgetConfigText] = useState(JSON.stringify(defaultBudgetConfig(), null, 2));
  const [aiLogs, setAiLogs] = useState(null);
  const [fullAiReply, setFullAiReply] = useState(null);
  const [weatherConfig, setWeatherConfig] = useState({ trainingDate: "", longitude: "", latitude: "" });
  const [weatherResult, setWeatherResult] = useState(null);

  useEffect(() => {
    if (!unlocked || !event?.id || !payload) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const plans = (payload?.participants || []).map((participant) => normalizePanelPlan(event.id, participant));
        const next = await coachPost(`/api/teaching/events/${encodeURIComponent(event.id)}/lesson-context`, {
          plans,
          teachingMethodManual,
          teachingMaterial: extraTeachingMaterial,
          budgetConfig: JSON.parse(budgetConfigText || "{}"),
        });
        if (!cancelled) setTeachingMaterial(JSON.stringify(next.context || {}, null, 2));
      } catch (error) {
        if (!cancelled) setStatus(`传入资料刷新失败：${error.message}`);
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [budgetConfigText, event?.id, extraTeachingMaterial, payload, teachingMethodManual, unlocked]);

  async function loadPlan() {
    if (!event?.id) return;
    setStatus("正在读取备课方案...");
    try {
      const nextPayload = await coachGet(`/api/teaching/events/${encodeURIComponent(event.id)}/plan`);
      const weatherResult = await Promise.resolve(coachGet(`/api/training-events/${encodeURIComponent(event.id)}/weather-config`))
        .then((value) => ({ status: "fulfilled", value }))
        .catch((reason) => ({ status: "rejected", reason }));
      const weatherPayload = weatherResult.status === "fulfilled" ? weatherResult.value : null;
      setPayload(nextPayload);
      const nextWeatherConfig = weatherPayload?.config || { trainingDate: "", longitude: "", latitude: "" };
      setWeatherConfig(nextWeatherConfig);
      setWeatherResult(nextWeatherConfig.lessonWeather || null);
      setAiSystemPrompt(nextPayload?.aiContext?.systemPrompt || "");
      setTeachingMaterial(nextPayload?.aiContext?.teachingMaterial || "");
      setExtraTeachingMaterial(nextPayload?.aiContext?.extraTeachingMaterial || "");
      setTeachingMethodManual(nextPayload?.aiContext?.teachingMethodManual || "");
      setBudgetConfigText(JSON.stringify(nextPayload?.aiContext?.budgetConfig || defaultBudgetConfig(), null, 2));
      const optionalErrors = [weatherResult].filter((item) => item.status === "rejected").map((item) => item.reason?.message).filter(Boolean);
      setStatus(optionalErrors.length ? `备课方案已读取；可选接口未命中：${optionalErrors.join("；")}` : "");
    } catch (error) {
      setStatus(`读取失败：${error.message}`);
    }
  }

  async function unlock() {
    const nextPassword = password.trim();
    if (!nextPassword) {
      setStatus("请输入教练密码");
      return;
    }
    try {
      await validateCoachPassword(nextPassword);
      setCoachPassword(nextPassword);
      setUnlocked(true);
      await loadPlan();
    } catch (error) {
      setStatus(error.message || "密码不正确");
    }
  }

  async function generateAll() {
    setStatus("正在生成备课方案...");
    try {
      const plans = (payload?.participants || []).map((participant) => normalizePanelPlan(event.id, participant));
      const nextPayload = await coachPost(`/api/teaching/events/${encodeURIComponent(event.id)}/prepare`, {
        plans,
        regenerate: true,
        aiSystemPrompt,
        teachingMaterial: extraTeachingMaterial,
        teachingMethodManual,
        budgetConfig: JSON.parse(budgetConfigText || "{}"),
      });
      if (nextPayload?.fallbackRequired) {
        setAiLogs(nextPayload?.aiLogs || null);
        setStatus(nextPayload.error || "AI生成失败");
        return;
      }
      setPayload(nextPayload);
      setAiLogs(nextPayload?.aiLogs || null);
      const failedCount = (nextPayload?.aiLogs?.failedPilots || []).length;
      const detail = nextPayload?.aiContext?.generationDetail || "已生成备课方案";
      setStatus(failedCount ? `${detail}；失败学员可在对应卡片点“重新生成”` : detail);
    } catch (error) {
      setStatus(`生成失败：${error.message}`);
    }
  }

  async function saveAll() {
    if (!payload?.participants?.length) return;
    setStatus("正在保存全部学员方案...");
    try {
      const plans = payload.participants.map((participant) => normalizePanelPlan(event.id, participant));
      const nextPayload = await coachPut(`/api/teaching/events/${encodeURIComponent(event.id)}/plans`, { plans });
      setPayload(nextPayload);
      setStatus("已保存全部学员方案");
    } catch (error) {
      setStatus(`保存失败：${error.message}`);
    }
  }

  async function saveAndQueryWeather() {
    setStatus("正在保存天气配置并查询降水...");
    try {
      const savedLocation = await coachPost(`/api/training-events/${encodeURIComponent(event.id)}/weather-config`, weatherConfig);
      const normalizedConfig = savedLocation.config || weatherConfig;
      setWeatherConfig(normalizedConfig);
      const params = new URLSearchParams({
        lon: String(normalizedConfig.longitude ?? ""),
        lat: String(normalizedConfig.latitude ?? ""),
        date: normalizedConfig.trainingDate || "",
        startHour: "0",
        endHour: "24",
      });
      const result = await coachGet(`/api/weather/lesson-hourly?${params.toString()}`);
      setWeatherResult(result);
      const saved = await coachPost(`/api/training-events/${encodeURIComponent(event.id)}/weather-config`, {
        ...normalizedConfig,
        lessonWeather: result,
      });
      setWeatherConfig(saved.config || { ...normalizedConfig, lessonWeather: result });
      setStatus("天气信息已更新");
    } catch (error) {
      setStatus(`天气查询失败：${error.message}`);
    }
  }

  async function saveManual() {
    setStatus("正在保存教学方法手册...");
    try {
      const saved = await coachPost("/api/teaching/lesson-manual", { manual: teachingMethodManual });
      setTeachingMethodManual(saved.manual || teachingMethodManual);
      setStatus("已保存教学方法手册");
    } catch (error) {
      setStatus(`手册保存失败：${error.message}`);
    }
  }

  async function saveSystemPrompt() {
    setStatus("正在保存系统提示词...");
    try {
      const saved = await coachPost("/api/teaching/lesson-system-prompt", { systemPrompt: aiSystemPrompt });
      setAiSystemPrompt(saved.systemPrompt || aiSystemPrompt);
      setStatus("已保存系统提示词");
    } catch (error) {
      setStatus(`系统提示词保存失败：${error.message}`);
    }
  }

  async function saveExtraMaterial() {
    setStatus("正在保存补充资料...");
    try {
      const saved = await coachPost("/api/teaching/lesson-extra-material", { material: extraTeachingMaterial });
      setExtraTeachingMaterial(saved.material || "");
      setStatus("已保存补充资料");
    } catch (error) {
      setStatus(`补充资料保存失败：${error.message}`);
    }
  }

  async function saveBudgetConfig() {
    setStatus("正在保存预算模板...");
    try {
      const config = JSON.parse(budgetConfigText || "{}");
      const saved = await coachPost("/api/teaching/lesson-budget-config", { config });
      setBudgetConfigText(JSON.stringify(saved.config || config, null, 2));
      setStatus("已保存预算模板");
    } catch (error) {
      setStatus(`预算模板保存失败：${error.message}`);
    }
  }

  async function runPersonalAi(pilotId, options = {}) {
    const plans = (payload?.participants || []).map((participant) => normalizePanelPlan(event.id, participant));
    const result = await coachPost(`/api/teaching/events/${encodeURIComponent(event.id)}/plan/${encodeURIComponent(pilotId)}/ai`, {
      plans,
      instruction: options.instruction,
      regenerate: options.regenerate,
      aiSystemPrompt,
      teachingMaterial: extraTeachingMaterial,
      teachingMethodManual,
      budgetConfig: JSON.parse(budgetConfigText || "{}"),
    });
    if (result?.fallbackRequired) {
      const failure = result.log?.error || result.error || "AI生成失败";
      setAiLogs({
        personalCalls: result.log ? [result.log] : [],
        failedPilots: [{ pilotId, pilotName: result.log?.pilotName || pilotId, error: failure }],
      });
      throw new Error(failure);
    }
    if (result.plan) updateParticipantPlan(pilotId, result.plan);
    setAiLogs({ personalCalls: [result.log], failedPilots: [] });
    return result;
  }

  function updateParticipantPlan(pilotId, plan) {
    setPayload((current) => ({
      ...current,
      participants: (current?.participants || []).map((participant) => (
        participant.pilotId === pilotId ? { ...participant, plan } : participant
      )),
    }));
  }

  if (!event?.id || !event?.name) {
    return (
      <section style={panelStyle}>
        <h2 style={{ margin: 0, fontWeight: 900, textAlign: "left" }}>智能备课</h2>
        <div style={{ color: "#64748b", fontSize: 13, marginTop: 8 }}>先保存训练事件后再生成备课方案。</div>
      </section>
    );
  }

  return (
    <section style={panelStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontWeight: 900, textAlign: "left" }}>智能备课</h2>
          <div style={{ color: "#64748b", fontSize: 13, marginTop: 6 }}>选择技能树星星制定教学目标。</div>
          {status && <div style={{ color: status.includes("失败") || status.includes("不正确") || status.includes("错误") || status.includes("Failed") ? "#b91c1c" : "#047857", fontSize: 13, marginTop: 6 }}>{status}</div>}
        </div>
        {unlocked && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" style={buttonStyle} onClick={loadPlan}>刷新</button>
            <button type="button" style={buttonStyle} onClick={saveAll}>保存全部</button>
            <button type="button" style={primaryButtonStyle} onClick={generateAll}>AI 生成</button>
          </div>
        )}
      </div>

      {!unlocked ? (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(160px,1fr) auto", gap: 8, maxWidth: 420 }}>
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="教练密码" style={inputStyle} />
          <button type="button" style={buttonStyle} onClick={unlock}>解锁备课</button>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {[
              ["edit", "备课编辑"],
              ["student", "学员学案页面"],
              ["coach", "教练任务页面"],
            ].map(([mode, label]) => (
              <button key={mode} type="button" style={viewMode === mode ? primaryButtonStyle : buttonStyle} onClick={() => setViewMode(mode)}>{label}</button>
            ))}
          </div>

          <div style={{ border: "1px solid #dbeafe", borderRadius: 12, padding: 12, background: "#eff6ff", display: "grid", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <strong style={{ color: "#0f172a" }}>训练天气预警</strong>
              {weatherResult?.suggestion && <span style={{ color: weatherResult.riskLevel === "high" ? "#b91c1c" : "#334155", fontSize: 13 }}>{weatherResult.suggestion}</span>}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr)) auto", gap: 8, alignItems: "center" }}>
              <input type="date" value={weatherConfig.trainingDate || ""} onChange={(event) => setWeatherConfig((current) => ({ ...current, trainingDate: event.target.value }))} style={inputStyle} />
              <input value={weatherConfig.longitude ?? ""} onChange={(event) => setWeatherConfig((current) => ({ ...current, longitude: event.target.value }))} placeholder="经度，如 113.25" aria-label="经度（-180 到 180）" style={inputStyle} />
              <input value={weatherConfig.latitude ?? ""} onChange={(event) => setWeatherConfig((current) => ({ ...current, latitude: event.target.value }))} placeholder="纬度，如 23.13" aria-label="纬度（-90 到 90）" style={inputStyle} />
              <button type="button" style={primaryButtonStyle} onClick={saveAndQueryWeather}>查询降水</button>
            </div>
            {weatherResult && (
              <div style={{ display: "grid", gap: 10 }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(118px,1fr))", gap: 8 }}>
                  {[
                    ["风险等级", weatherResult.riskLevel || "--"],
                    ["最大降水概率", `${weatherResult.maxPop ?? 0}%`],
                    ["累计降水量", `${weatherResult.totalPrecip ?? 0} mm`],
                    ["降雨小时数", `${weatherResult.rainHours ?? 0}`],
                    ["最大风速", `${weatherResult.maxWind ?? 0} km/h`],
                    ["平均温度", `${weatherResult.avgTemp ?? 0}℃`],
                    ["最低/最高温", `${weatherResult.minTemp ?? 0}/${weatherResult.maxTemp ?? 0}℃`],
                    ["平均湿度", `${weatherResult.avgHumidity ?? 0}%`],
                    ["最大湿度", `${weatherResult.maxHumidity ?? 0}%`],
                  ].map(([label, value]) => (
                    <div key={label} style={{ border: "1px solid #dbeafe", borderRadius: 9, padding: 8, background: "#fff" }}>
                      <div style={{ color: "#64748b", fontSize: 12 }}>{label}</div>
                      <strong style={{ color: "#0f172a" }}>{value}</strong>
                    </div>
                  ))}
                </div>
                <PrecipBarChart title="0:00–24:00 降水趋势" items={weatherResult.hourly || []} emptyText="该时段暂无降水" />
              </div>
            )}
          </div>

          <details style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, background: "#fff" }}>
            <summary style={{ cursor: "pointer", fontWeight: 900 }}>AI 系统提示词和传入资料</summary>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 10, marginTop: 10 }}>
              <label style={{ display: "grid", gap: 6 }}>
                <span style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                  <strong style={{ fontSize: 13 }}>系统提示词</strong>
                  <button type="button" style={{ ...buttonStyle, height: 28, padding: "0 8px", fontSize: 12 }} onClick={saveSystemPrompt}>保存提示词</button>
                </span>
                <textarea value={aiSystemPrompt} onChange={(event) => setAiSystemPrompt(event.target.value)} style={{ ...inputStyle, minHeight: 210, height: 210, padding: 10, fontSize: 12, lineHeight: 1.5, resize: "vertical" }} />
              </label>
              <label style={{ display: "grid", gap: 6 }}>
                <span style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                  <strong style={{ fontSize: 13 }}>教学方法手册</strong>
                  <button type="button" style={{ ...buttonStyle, height: 28, padding: "0 8px", fontSize: 12 }} onClick={saveManual}>保存手册</button>
                </span>
                <textarea value={teachingMethodManual} onChange={(event) => setTeachingMethodManual(event.target.value)} style={{ ...inputStyle, minHeight: 210, height: 210, padding: 10, fontSize: 12, lineHeight: 1.5, resize: "vertical" }} />
              </label>
              <label style={{ display: "grid", gap: 6 }}>
                <strong style={{ fontSize: 13 }}>传入资料 JSON </strong>
                <textarea value={teachingMaterial} readOnly style={{ ...inputStyle, minHeight: 210, height: 210, padding: 10, fontSize: 12, lineHeight: 1.5, resize: "vertical", fontFamily: "Consolas, monospace", background: "#f8fafc" }} />
              </label>
              <label style={{ display: "grid", gap: 6 }}>
                <span style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                  <strong style={{ fontSize: 13 }}>补充资料</strong>
                  <button type="button" style={{ ...buttonStyle, height: 28, padding: "0 8px", fontSize: 12 }} onClick={saveExtraMaterial}>保存补充资料</button>
                </span>
                <textarea value={extraTeachingMaterial} onChange={(event) => setExtraTeachingMaterial(event.target.value)} placeholder="只填写额外规则、场地限制或临时要求；数据库、目标星星和预算会自动进入上面的 JSON。" style={{ ...inputStyle, minHeight: 120, height: 170, padding: 10, fontSize: 12, lineHeight: 1.5, resize: "vertical" }} />
              </label>
              <label style={{ display: "grid", gap: 6 }}>
                <span style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                  <strong style={{ fontSize: 13 }}>教练预算模板</strong>
                  <button type="button" style={{ ...buttonStyle, height: 28, padding: "0 8px", fontSize: 12 }} onClick={saveBudgetConfig}>保存预算模板</button>
                </span>
                <textarea value={budgetConfigText} onChange={(event) => setBudgetConfigText(event.target.value)} style={{ ...inputStyle, minHeight: 170, height: 170, padding: 10, fontSize: 12, lineHeight: 1.5, resize: "vertical", fontFamily: "Consolas, monospace" }} />
              </label>
            </div>
            <div style={{ color: "#64748b", fontSize: 12, marginTop: 8 }}>
              这些内容会随全局生成和单人卡片一起提交给AI。
            </div>
          </details>

          {aiLogs && (
            <details style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 10, background: "#f8fafc", color: "#334155", fontSize: 12 }}>
              <summary style={{ cursor: "pointer", fontWeight: 800 }}>
                调用日志：总耗时 {aiLogs.totalDurationMs || 0}ms；失败学员 {(aiLogs.failedPilots || []).length} 人；单人调用 {(aiLogs.personalCalls || []).length} 次。
              </summary>
              <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
              {(aiLogs.failedPilots || []).length > 0 && (
                <div style={{ display: "grid", gap: 4, color: "#b91c1c" }}>
                  {(aiLogs.failedPilots || []).map((item) => (
                    <div key={`${item.pilotId}-${item.error}`}>失败：{item.pilotName || item.pilotId}，{item.error || "无错误详情"}</div>
                  ))}
                </div>
              )}
              {(aiLogs.personalCalls || []).length > 0 && (
                <div style={{ display: "grid", gap: 4 }}>
                  {(aiLogs.personalCalls || []).map((item, index) => (
                    <div key={`${item.pilotId || index}-${index}`} style={{ display: "grid", gap: 2 }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        {item.pilotName || item.pilotId || "未知学员"}：{item.error ? `失败，${item.error}` : `耗时 ${item.durationMs || 0}ms，输入 ${item.inputChars || 0} 字，输出 ${item.outputChars || 0} 字，tokens ${item.tokenUsage || 0}`}
                        {(item.outputFull || item.outputPreview) && (
                          <button
                            type="button"
                            style={{ ...buttonStyle, height: 24, padding: "0 8px", fontSize: 12 }}
                            onClick={() => setFullAiReply({
                              title: `${item.pilotName || item.pilotId || "未知学员"} AI 回复全文`,
                              content: item.outputFull || item.outputPreview || "",
                            })}
                          >
                            AI 回复全文
                          </button>
                        )}
                      </div>
                      {(item.outputFull || item.outputPreview) && (
                        <div style={{ color: "#64748b" }}>
                          {item.outputPreview && <span style={{ color: "#64748b" }}>返回预览：{item.outputPreview}</span>}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              </div>
            </details>
          )}

          {fullAiReply && (
            <div
              role="dialog"
              aria-modal="true"
              aria-label={fullAiReply.title}
              style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(15,23,42,0.45)", display: "grid", placeItems: "center", padding: 16 }}
              onClick={() => setFullAiReply(null)}
            >
              <div
                style={{ width: "min(920px, 100%)", maxHeight: "min(720px, 90vh)", background: "#fff", borderRadius: 12, boxShadow: "0 24px 70px rgba(15,23,42,0.25)", display: "grid", gridTemplateRows: "auto minmax(0,1fr)", overflow: "hidden" }}
                onClick={(event) => event.stopPropagation()}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", padding: "12px 14px", borderBottom: "1px solid #e5e7eb" }}>
                  <strong style={{ color: "#0f172a", fontSize: 14 }}>{fullAiReply.title}</strong>
                  <button type="button" aria-label="关闭 AI 回复全文" style={{ ...buttonStyle, height: 30, padding: "0 10px", fontSize: 12 }} onClick={() => setFullAiReply(null)}>关闭</button>
                </div>
                <pre style={{ margin: 0, padding: 14, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word", textAlign: "left", fontFamily: "Consolas, monospace", fontSize: 12, lineHeight: 1.55, color: "#0f172a", background: "#f8fafc" }}>{fullAiReply.content || "暂无回复内容"}</pre>
              </div>
            </div>
          )}

          {viewMode === "edit" && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(360px,1fr))", gap: 12 }}>
              {(payload?.participants || []).length === 0 && <div style={{ color: "#64748b", fontSize: 13 }}>当前事件还没有参与飞手。</div>}
              {(payload?.participants || []).map((participant) => (
                <LessonPlanCard
                  key={participant.pilotId}
                  eventId={event.id}
                  participant={participant}
                  onChange={updateParticipantPlan}
                  onSave={saveAll}
                  onAi={runPersonalAi}
                />
              ))}
            </div>
          )}
          {viewMode === "student" && <StudentLessonPage participants={payload?.participants || []} track={payload?.track || null} />}
          {viewMode === "coach" && (
            <CoachTaskEditorPage
              eventId={event.id}
              participants={payload?.participants || []}
            />
          )}
        </div>
      )}
    </section>
  );
}

function ReceiverArrayPanel({ serialState, externalCollector, onConnectSerial, onDisconnectSerial }) {
  const identifiedCount = serialState.connected ? serialState.maxReceiverId || 0 : 0;
  const onlineCount = serialState.connected ? serialState.receiverCount || 0 : 0;
  const infoBoxStyle = {
    ...inputStyle,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };
  const portBoxStyle = {
    ...infoBoxStyle,
    fontSize: "clamp(11px, 2.8vw, 14px)",
    maxWidth: 220,
    justifySelf: "center",
    width: "100%",
  };
  return (
    <section style={panelStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontWeight: 900, textAlign: "left" }}>接收阵列</h2>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {externalCollector ? <span>串口由 Windows 托盘程序管理</span> : <>
            <button type="button" style={primaryButtonStyle} onClick={onConnectSerial} disabled={serialState.connecting || serialState.connected || !serialState.supported}>
              {serialState.connecting ? "连接中..." : "连接阵列"}
            </button>
            {serialState.connected && <button type="button" style={dangerButtonStyle} onClick={onDisconnectSerial}>断开阵列</button>}
          </>}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 10 }}>
        <div style={infoBoxStyle}>串口：{serialState.connected ? "已连接" : "未连接"}</div>
        <div style={portBoxStyle} title={serialState.portName || "未选择"}>端口：{serialState.portName || "未选择"}</div>
        <div style={infoBoxStyle}>波特率：{serialState.baudRate || 115200}</div>
        <div style={infoBoxStyle}>识别数量：{identifiedCount}</div>
        <div style={infoBoxStyle}>在线接收机：{onlineCount}</div>
        <div style={infoBoxStyle}>最后 RX：{serialState.lastReceiverId || "暂无"}</div>
        <div style={infoBoxStyle}>最后数据：{formatSerialTime(serialState.lastDataAt)}</div>
      </div>
      {(!serialState.supported || serialState.error || serialState.lastCommand || serialState.lastLine) && (
        <div style={{ marginTop: 10, color: !serialState.supported || serialState.error ? "#b91c1c" : "#64748b", fontSize: 13 }}>
          {!serialState.supported && <div>当前浏览器不支持 Web Serial，请使用 Edge/Chrome 并通过 localhost 或 HTTPS 打开页面。</div>}
          {serialState.error && <div style={{ wordBreak: "break-all" }}>{serialState.error}</div>}
          {!serialState.error && serialState.lastCommand && <div>最后指令：{serialState.lastCommand}</div>}
          {!serialState.error && serialState.lastLine && (
            <div style={{ marginTop: 8 }}>
              <div style={{ marginBottom: 4, fontWeight: 800 }}>最后一行串口信息：</div>
              <pre style={{ margin: 0, padding: 10, border: "1px solid #e5e7eb", borderRadius: 8, background: "#f8fafc", color: "#334155", whiteSpace: "pre-wrap", wordBreak: "break-all", overflowX: "auto", maxHeight: 180 }}>
                {serialState.lastLine}
              </pre>
            </div>
          )}
        </div>
      )}
      {/*
        <div style={{ marginTop: 10, color: !serialState.supported || serialState.error ? "#b91c1c" : "#64748b", fontSize: 13, wordBreak: "break-all" }}>
          {!serialState.supported ? "当前浏览器不支持 Web Serial，请使用 Edge/Chrome 并通过 localhost 或 HTTPS 打开页面。" : serialState.error || `最后指令：${serialState.lastCommand || "无"}；最后一行：${serialState.lastLine || "暂无"}`}
        </div>
      */}
    </section>
  );
}

function ReceiverStatus({ receivers, participants, pilots, externalCollector, onBindReceiver }) {
  const [bindingId, setBindingId] = useState(null);
  const pilotById = new Map((pilots || []).map((pilot) => [pilot.id, pilot.name]));
  const participantByReceiver = new Map((participants || []).map((participant) => [Number(participant.receiverId), participant]));
  const receiverById = new Map((receivers || []).map((receiver) => [Number(receiver.id), receiver]));
  const receiverIds = [...new Set([...participantByReceiver.keys(), ...receiverById.keys()])]
    .filter((id) => Number.isInteger(id) && id > 0).sort((left, right) => left - right);

  async function bindReceiver(id) {
    setBindingId(id);
    try {
      await onBindReceiver(id);
    } finally {
      setBindingId(null);
    }
  }

  return (
    <section style={panelStyle}>
      <h2 style={{ margin: "0 0 12px", fontWeight: 900, textAlign: "left" }}>接收机节点状态</h2>
      {receiverIds.length === 0 && (
        <div style={{ color: "#64748b", fontSize: 13 }}>还未从串口识别到接收机。</div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: 10 }}>
        {receiverIds.map((id) => {
          const receiver = receiverById.get(id) || { id, online: false, paired: false };
          const participant = participantByReceiver.get(id);
          const pilotName = pilotById.get(participant?.pilotId) || participant?.pilotId || receiver.name || "未分配飞手";
          return (
          <div key={receiver.id} style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, background: receiver.online ? "#f0fdf4" : "#f8fafc" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
              <strong>{pilotName}</strong>
              <span style={{ color: receiver.online ? "#047857" : "#64748b", fontSize: 13 }}>{receiver.online ? "在线" : "离线"}</span>
            </div>
            <div style={{ color: "#64748b", fontSize: 12, marginTop: 4 }}>接收机 RX {receiver.id}</div>
            <div style={{ color: !receiver.online ? "#64748b" : receiver.paired ? "#047857" : "#b45309", fontSize: 12, marginTop: 6 }}>
              {!receiver.online ? "离线" : receiver.paired ? "已对频" : "未对频"}
            </div>
            <div style={{ color: "#64748b", fontSize: 12, marginTop: 4 }}>
              LQ：{receiver.lq ?? "无"} RSSI：{receiver.rssi ?? "无"}
            </div>
            <div style={{ color: "#64748b", fontSize: 12, marginTop: 4 }}>
              最后数据：{formatSerialTime(receiver.lastSeenAt)}
            </div>
            {externalCollector ? <div style={{ marginTop: 10, fontSize: 12, color: "#64748b" }}>请在 Windows 托盘程序中对频</div>
              : <button type="button" style={{ ...buttonStyle, marginTop: 10, width: "100%" }} onClick={() => bindReceiver(receiver.id)} disabled={bindingId === receiver.id}>
                {bindingId === receiver.id ? "发送中..." : "对频"}
              </button>}
          </div>
          );
        })}
      </div>
    </section>
  );
}

function formatPowerValue(value, digits, unit) {
  return Number.isFinite(value) ? `${value.toFixed(digits)} ${unit}` : `-- ${unit}`;
}

function ReceiverPowerPanel({ power }) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const voltageV = power?.voltageV;
  const currentA = power?.currentA;
  const powerW = power?.powerW;
  const ageMs = power?.updatedAt && now ? Math.max(0, now - power.updatedAt) : null;
  const stale = ageMs === null || ageMs > 3000;
  const itemStyle = {
    ...inputStyle,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    minWidth: 0,
  };
  return (
    <section style={panelStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontWeight: 900, textAlign: "left" }}>接收阵列电源监测</h2>
        <span style={{ color: stale ? "#b45309" : "#047857", fontSize: 13, fontWeight: 800 }}>
          {stale ? "等待数据" : `更新于 ${Math.round(ageMs / 1000)} 秒前`}
        </span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 10 }}>
        <div style={itemStyle}><span>电压</span><strong>{formatPowerValue(voltageV, 2, "V")}</strong></div>
        <div style={itemStyle}><span>电流</span><strong>{formatPowerValue(currentA, 3, "A")}</strong></div>
        <div style={itemStyle}><span>功率</span><strong>{formatPowerValue(powerW, 2, "W")}</strong></div>
      </div>
    </section>
  );
}

export default function EventPage({ pilots, events, live, serialState, serialPower, externalCollector = false, onConnectSerial, onDisconnectSerial, onSaveEvents, onBindReceiver }) {
  const activeEvent = events.find((event) => event.active);
  const [draftEvent, setDraftEvent] = useState(activeEvent || events[0] || makeEvent());
  const initialSelectionResolvedRef = useRef(Boolean(activeEvent || events[0]));
  const [busyText, setBusyText] = useState("");
  const currentEvent = draftEvent;
  useEffect(() => {
    if (initialSelectionResolvedRef.current || !events.length) return;
    initialSelectionResolvedRef.current = true;
    setDraftEvent((current) => current.name || current.participants.length ? current : activeEvent || events[0]);
  }, [activeEvent, events]);
  const receiverIds = useMemo(() => {
    const count = Math.max(16, Number(serialState.maxReceiverId || serialState.receiverCount || 0));
    const ids = new Set(Array.from({ length: count }, (_, index) => index + 1));
    for (const receiver of live.receivers || []) ids.add(Number(receiver.id));
    return [...ids].filter((id) => Number.isFinite(id) && id > 0).sort((left, right) => left - right);
  }, [live.receivers, serialState.maxReceiverId, serialState.receiverCount]);

  function getDuplicateName(event) {
    const name = event.name.trim();
    if (!name) return "训练名称不能为空";
    if (events.some((item) => item.id !== event.id && item.name.trim() === name)) return `已经存在同名训练事件：${name}`;
    const duplicateChannel = duplicateVideoChannel(event.participants || []);
    return duplicateChannel ? `图传频点 ${duplicateChannel} 已分配给其他飞手` : "";
  }

  async function saveDraft(event = currentEvent) {
    const error = getDuplicateName(event);
    if (error) {
      setBusyText(error);
      return false;
    }
    const eventToSave = { ...event, createdAt: event.createdAt || Date.now() };
    const exists = events.some((item) => item.id === event.id);
    setBusyText("正在保存事件...");
    try {
      const savedEvents = await onSaveEvents(exists ? events.map((item) => (item.id === event.id ? eventToSave : item)) : [eventToSave, ...events]);
      setDraftEvent(savedEvents?.find((item) => item.id === event.id) || eventToSave);
      setBusyText(exists ? `已更新 ${event.name} 的配置` : `已新建 ${event.name}`);
      return true;
    } catch (saveError) {
      setBusyText(`事件保存失败：${saveError.message}`);
      return false;
    }
  }

  function updateParticipant(index, patch) {
    setDraftEvent((event) => ({
      ...event,
      participants: event.participants.map((participant, itemIndex) => (
        itemIndex === index ? { ...participant, ...patch } : participant
      )),
    }));
  }

  function selectablePilots(index) {
    const selected = new Set(currentEvent.participants.map((participant, itemIndex) => (itemIndex === index ? null : participant.pilotId)));
    return pilots.filter((pilot) => !selected.has(pilot.id));
  }

  function hasAvailablePilot() {
    const selected = new Set(currentEvent.participants.map((participant) => participant.pilotId).filter(Boolean));
    return pilots.some((pilot) => !selected.has(pilot.id));
  }

  function addParticipant() {
    const selected = new Set(currentEvent.participants.map((participant) => participant.pilotId).filter(Boolean));
    const nextPilot = pilots.find((pilot) => !selected.has(pilot.id));
    if (!nextPilot) {
      setBusyText("所有飞手都已经加入当前事件");
      return;
    }
    setDraftEvent((event) => ({
      ...event,
      participants: [...event.participants, makeParticipant(nextPilot, event.participants.length)],
    }));
  }

  function removeParticipant(index) {
    setDraftEvent((event) => ({
      ...event,
      participants: event.participants.filter((_, itemIndex) => itemIndex !== index),
    }));
  }

  function updateVideoBand(index, videoBand) {
    updateParticipant(index, { videoBand, videoChannel: "" });
  }

  function updateVideoNumber(index, number) {
    const videoBand = currentEvent.participants[index]?.videoBand || currentEvent.participants[index]?.videoChannel?.[0] || "";
    const videoChannel = videoBand && number ? `${videoBand}${number}` : "";
    updateParticipant(index, { videoBand, videoChannel });
  }

  function createNewEvent() {
    if (events.some((event) => event.active)) {
      setBusyText("记录状态下不能新建事件，请先结束当前训练");
      return;
    }
    const nextEvent = makeEvent();
    initialSelectionResolvedRef.current = true;
    setDraftEvent(nextEvent);
    setBusyText("已新建初始配置，请填写训练名称后保存配置");
  }

  async function startEvent() {
    const nextEvents = events.map((event) => ({ ...event, active: false }));
    const exists = events.some((event) => event.id === currentEvent.id);
    if (!exists) {
      setBusyText("请先保存配置，再开始记录");
      return;
    }
    const nextEvent = { ...currentEvent, startedAt: currentEvent.startedAt || Date.now(), endedAt: null, active: true, records: currentEvent.records || [] };
    if (getDuplicateName(nextEvent)) {
      setBusyText(getDuplicateName(nextEvent));
      return;
    }
    setBusyText("正在开始训练...");
    try {
      let savedEvent = nextEvent;
      try {
        const saved = await apiPost("/api/events/start", nextEvent);
        savedEvent = saved.event || nextEvent;
      } catch {
        // 兼容旧后端。
      }
      const savedEvents = await onSaveEvents(nextEvents.map((event) => (event.id === nextEvent.id ? savedEvent : event)));
      setDraftEvent(savedEvents?.find((event) => event.id === nextEvent.id) || savedEvent);
      setBusyText(currentEvent.startedAt ? "已继续记录，本次数据会追加到同一个事件" : "训练已开始记录");
    } catch (error) {
      setBusyText(`开始训练失败：${error.message}`);
    }
  }

  async function endEvent() {
    setBusyText("正在结束训练...");
    try {
      let savedEvent = { ...currentEvent, endedAt: Date.now(), active: false };
      try {
        const saved = await apiPost(`/api/events/${currentEvent.id}/end`, {});
        savedEvent = saved.event || savedEvent;
      } catch {
        // 兼容旧后端。
      }
      const savedEvents = await onSaveEvents(events.map((event) => (event.id === currentEvent.id ? savedEvent : event)));
      setDraftEvent(savedEvents?.find((event) => event.id === currentEvent.id) || savedEvent);
      setBusyText("训练已结束并保存");
    } catch (error) {
      setBusyText(`结束训练失败：${error.message}`);
    }
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <section style={panelStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div>
            <h2 style={{ margin: 0, fontWeight: 900, textAlign: "left" }}>事件和系统</h2>
            <div style={{ color: "#64748b", fontSize: 13, marginTop: 6 }}>初始配置 → 保存配置 → 空闲 → 开始记录 → 记录中。</div>
            {busyText && <div style={{ color: busyText.includes("失败") || busyText.includes("存在") || busyText.includes("不能为空") || busyText.includes("已分配") ? "#b91c1c" : "#047857", fontSize: 13, marginTop: 6 }}>{busyText}</div>}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" style={buttonStyle} onClick={createNewEvent} disabled={events.some((event) => event.active)}>新建事件</button>
            <button type="button" style={buttonStyle} onClick={() => saveDraft()}>保存配置</button>
            {!currentEvent.active && <button type="button" style={primaryButtonStyle} onClick={startEvent}>开始记录</button>}
            {currentEvent.active && <button type="button" style={dangerButtonStyle} onClick={endEvent}>结束并保存</button>}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "minmax(260px,1fr) 180px", gap: 10, marginTop: 14 }}>
          <label style={{ gridColumn: "1 / -1" }}>
            <div style={{ fontSize: 13, marginBottom: 6 }}>选择训练事件</div>
            <select
              aria-label="选择训练事件"
              value={events.some((event) => event.id === currentEvent.id) ? currentEvent.id : ""}
              onChange={(e) => {
                const selected = events.find((event) => event.id === e.target.value);
                if (!selected) return;
                setDraftEvent(selected);
                setBusyText(`已选择 ${selected.name}，可编辑配置或开始记录`);
              }}
              style={inputStyle}
            >
              <option value="">{events.length ? "选择已有训练事件" : "暂无已保存的训练事件"}</option>
              {events.map((event) => (
                <option key={event.id} value={event.id}>{event.name || "未命名事件"}{event.active ? " · 记录中" : event.startedAt ? " · 可继续记录" : " · 未开始"}</option>
              ))}
            </select>
          </label>
          <label>
            <div style={{ fontSize: 13, marginBottom: 6 }}>训练名称</div>
            <input value={currentEvent.name} onChange={(e) => setDraftEvent({ ...currentEvent, name: e.target.value })} style={{ ...inputStyle, fontSize: 14 }} />
          </label>
          <div>
            <div style={{ fontSize: 13, marginBottom: 6 }}>状态</div>
            <div style={{ ...inputStyle, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", fontSize: 14, fontWeight: 900, color: currentEvent.active ? "#047857" : "#64748b" }}>
              {currentEvent.active ? "记录状态" : events.some((event) => event.id === currentEvent.id) ? "事件空闲状态" : "初始配置状态"}
            </div>
          </div>
        </div>
      </section>

      <LessonPlanPanel event={currentEvent} />

      <ReceiverArrayPanel
        serialState={serialState}
        externalCollector={externalCollector}
        onConnectSerial={onConnectSerial}
        onDisconnectSerial={onDisconnectSerial}
      />

      <section style={panelStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontWeight: 900, textAlign: "left" }}>参与飞手与图传频点</h2>
          <button type="button" style={buttonStyle} onClick={addParticipant} disabled={!hasAvailablePilot()}>加入飞手</button>
        </div>

        <div style={{ display: "grid", gap: 10 }}>
          {!pilots.length && <div style={{ color: "#b45309", fontSize: 13 }}>飞手库为空，请先到飞手档案添加飞手。</div>}
          {currentEvent.participants.map((participant, index) => (
            <div key={`${participant.pilotId}-${index}`} style={{ display: "grid", gridTemplateColumns: "44px repeat(auto-fit,minmax(118px,1fr))", gap: 8, alignItems: "end", width: "100%", maxWidth: "100%" }}>
              <strong style={{ textAlign: "center", alignSelf: "center" }}>{index + 1}</strong>
              <select value={participant.pilotId} onChange={(e) => updateParticipant(index, { pilotId: e.target.value })} style={inputStyle}>
                <option value="">选择飞手</option>
                {selectablePilots(index).map((pilot) => <option key={pilot.id} value={pilot.id}>{pilot.name}</option>)}
              </select>
              <select value={participant.receiverId} onChange={(e) => updateParticipant(index, { receiverId: Number(e.target.value) })} style={inputStyle}>
                {receiverIds.map((receiverId) => <option key={receiverId} value={receiverId}>接收机 {receiverId}</option>)}
              </select>
              <select aria-label={`飞手 ${index + 1} 图传频段`} value={participant.videoBand || participant.videoChannel?.[0] || ""} onChange={(e) => updateVideoBand(index, e.target.value)} style={inputStyle}>
                <option value="">选择频段</option>
                {videoBandOptions.map((band) => <option key={band} value={band}>{band}</option>)}
              </select>
              <select aria-label={`飞手 ${index + 1} 图传频道`} value={participant.videoChannel ? participant.videoChannel.slice(1) : ""} onChange={(e) => updateVideoNumber(index, e.target.value)} style={inputStyle} disabled={!participant.videoBand && !participant.videoChannel}>
                <option value="">选择频道</option>
                {availableVideoNumbers(videoChannels.all, currentEvent.participants, index, participant.videoBand || participant.videoChannel?.[0] || "").map((number) => <option key={number} value={number}>{number}</option>)}
              </select>
              <label style={{ minWidth: 0 }}>
                <div style={{ color: "#64748b", fontSize: 12, marginBottom: 4 }}>有效开始</div>
                <input
                  type="datetime-local"
                  value={formatDateTimeLocal(participant.trainingStartAt)}
                  onChange={(e) => updateParticipant(index, { trainingStartAt: parseDateTimeLocal(e.target.value) })}
                  style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }}
                />
              </label>
              <label style={{ minWidth: 0 }}>
                <div style={{ color: "#64748b", fontSize: 12, marginBottom: 4 }}>有效结束</div>
                <input
                  type="datetime-local"
                  value={formatDateTimeLocal(participant.trainingEndAt)}
                  onChange={(e) => updateParticipant(index, { trainingEndAt: parseDateTimeLocal(e.target.value) })}
                  style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }}
                />
              </label>
              <button type="button" style={{ ...buttonStyle, alignSelf: "center" }} onClick={() => removeParticipant(index)}>移除</button>
            </div>
          ))}
        </div>
      </section>

      <ReceiverStatus receivers={live.receivers} participants={(activeEvent || currentEvent).participants} pilots={pilots} externalCollector={externalCollector} onBindReceiver={onBindReceiver} />
      <ReceiverPowerPanel power={serialPower || serialState.power} />
    </div>
  );
}
