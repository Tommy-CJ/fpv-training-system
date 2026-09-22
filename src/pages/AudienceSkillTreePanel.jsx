import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiGet, panelStyle } from "../trainingShared.js";

const NODE_W = 210;
const NODE_BASE_H = 76;
const H_GAP = 72;
const V_GAP = 28;
const ROOT_GAP = 56;
const PADDING_X = 24;
const PADDING_Y = 24;

const zoomBtnStyle = {
  border: "0",
  background: "#f8fafc",
  color: "#0f172a",
  borderRadius: 999,
  height: 28,
  minWidth: 28,
  padding: "0 10px",
  fontSize: 12,
  fontWeight: 800,
  cursor: "pointer",
  userSelect: "none",
  WebkitUserSelect: "none",
};

function criteriaList(skill) {
  return Array.isArray(skill?.star_criteria) ? skill.star_criteria : [];
}

function estimateLines(text, charsPerLine = 16) {
  const value = String(text || "").trim();
  if (!value) return 0;
  return Math.max(1, Math.ceil(value.length / charsPerLine));
}

function nodeHeight(skill) {
  const criteria = criteriaList(skill);

  const titleLines = estimateLines(skill?.name, 15);
  let h = 24 + titleLines * 18 + 12;

  if (skill?.description) {
    h += estimateLines(skill.description, 15) * 17 + 8;
  }

  if (criteria.length > 0) {
    h += 4;
    for (const item of criteria.slice(0, 5)) {
      const text = `${Number(item.star || 1)}星：${item.criterion || item.text || item.description || "暂无标准"}`;
      h += estimateLines(text, 13) * 17 + 5;
    }
  }

  h += 18;
  return Math.max(NODE_BASE_H, h);
}

function computeTreeLayout(skills) {
  const childrenByParent = new Map();
  const byId = new Map(skills.map((skill) => [skill.id, skill]));

  for (const skill of skills) {
    const parentId = skill.parent_id || "__root__";
    childrenByParent.set(parentId, [...(childrenByParent.get(parentId) || []), skill]);
  }

  const layout = new Map();
  const heightCache = new Map();

  function measureSubtree(skill) {
    if (heightCache.has(skill.id)) return heightCache.get(skill.id);

    const children = childrenByParent.get(skill.id) || [];
    const ownH = nodeHeight(skill);

    if (!children.length) {
      heightCache.set(skill.id, ownH);
      return ownH;
    }

    const childrenTotalH =
      children.reduce((sum, child) => sum + measureSubtree(child), 0) +
      Math.max(0, children.length - 1) * V_GAP;

    const h = Math.max(ownH, childrenTotalH);
    heightCache.set(skill.id, h);
    return h;
  }

  function place(skill, depth, topY) {
    const children = childrenByParent.get(skill.id) || [];
    const ownH = nodeHeight(skill);
    const subtreeH = measureSubtree(skill);
    const x = PADDING_X + depth * (NODE_W + H_GAP);

    if (!children.length) {
      layout.set(skill.id, {
        skill,
        x,
        y: topY + (subtreeH - ownH) / 2,
        h: ownH,
        subtreeH,
      });
      return subtreeH;
    }

    const childrenTotalH =
      children.reduce((sum, child) => sum + measureSubtree(child), 0) +
      Math.max(0, children.length - 1) * V_GAP;

    let childY = topY + Math.max(0, (subtreeH - childrenTotalH) / 2);

    for (const child of children) {
      const childH = measureSubtree(child);
      place(child, depth + 1, childY);
      childY += childH + V_GAP;
    }

    layout.set(skill.id, {
      skill,
      x,
      y: topY + (subtreeH - ownH) / 2,
      h: ownH,
      subtreeH,
    });

    return subtreeH;
  }

  const roots = childrenByParent.get("__root__") || skills.filter((skill) => !skill.parent_id);

  let cursorY = PADDING_Y;
  for (const root of roots) {
    const rootH = measureSubtree(root);
    place(root, 0, cursorY);
    cursorY += rootH + ROOT_GAP;
  }

  let width = 720;
  let height = Math.max(360, cursorY + PADDING_Y);

  for (const item of layout.values()) {
    width = Math.max(width, item.x + NODE_W + 32);
    height = Math.max(height, item.y + item.h + 32);
  }

  return { byId, childrenByParent, layout, roots, width, height };
}

function SkillNode({ skill, pos }) {
  const criteria = criteriaList(skill);
  const hasStars = criteria.length > 0;

  return (
    <div
      style={{
        position: "absolute",
        left: pos.x,
        top: pos.y,
        width: NODE_W,
        minHeight: pos.h,
        border: skill.parent_id ? "1px solid #d4d4d8" : "2px solid #93c5fd",
        borderRadius: 12,
        background: skill.parent_id ? "#fff" : "#f0f4ff",
        padding: "8px 10px",
        boxSizing: "border-box",
        boxShadow: "0 8px 20px rgba(15,23,42,.06)",
        display: "grid",
        gap: 5,
        userSelect: "none",
        WebkitUserSelect: "none",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
        <strong style={{ color: "#0f172a", fontSize: 13, lineHeight: 1.25, overflowWrap: "anywhere" }}>
          {skill.name}
        </strong>
        {hasStars && (
          <span style={{ color: "#f59e0b", fontSize: 11, whiteSpace: "nowrap" }}>
            {"⭐".repeat(Math.min(5, criteria.length))}
          </span>
        )}
      </div>

      {skill.description && (
        <div style={{ color: "#475569", fontSize: 11.5, lineHeight: 1.35, overflowWrap: "anywhere" }}>
          {skill.description}
        </div>
      )}

      {hasStars && (
        <div style={{ display: "grid", gap: 3 }}>
          {criteria.slice(0, 5).map((item, index) => (
            <div
              key={`${skill.id}-${item.star || index}`}
              style={{ color: "#334155", fontSize: 11, lineHeight: 1.3, overflowWrap: "anywhere" }}
            >
              <b style={{ color: "#92400e" }}>{Number(item.star || index + 1)}星：</b>
              {item.criterion || item.text || item.description || "暂无标准"}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AudienceSkillTreePanel() {
  const [skills, setSkills] = useState([]);
  const [status, setStatus] = useState("正在读取技能树...");
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const [dragging, setDragging] = useState(false);

  const viewportRef = useRef(null);
  const dragRef = useRef({ x: 0, y: 0, viewX: 0, viewY: 0 });

  const tree = useMemo(() => computeTreeLayout(skills), [skills]);

  const fitToScreen = useCallback(() => {
    const el = viewportRef.current;
    if (!el || !tree.width || !tree.height) return;

    const padding = 40;
    const scaleX = (el.clientWidth - padding) / tree.width;
    const scaleY = (el.clientHeight - padding) / tree.height;
    const scale = Math.min(1, Math.max(0.25, Math.min(scaleX, scaleY)));

    setView({
      scale,
      x: Math.max(20, (el.clientWidth - tree.width * scale) / 2),
      y: Math.max(20, (el.clientHeight - tree.height * scale) / 2),
    });
  }, [tree.height, tree.width]);

  function zoomBy(delta) {
    const el = viewportRef.current;
    if (!el) return;

    setView((prev) => {
      const nextScale = Math.min(2, Math.max(0.25, prev.scale + delta));
      const cx = el.clientWidth / 2;
      const cy = el.clientHeight / 2;

      return {
        scale: nextScale,
        x: cx - ((cx - prev.x) / prev.scale) * nextScale,
        y: cy - ((cy - prev.y) / prev.scale) * nextScale,
      };
    });
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();

    setDragging(true);
    dragRef.current = {
      x: e.clientX,
      y: e.clientY,
      viewX: view.x,
      viewY: view.y,
    };

    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e) {
    if (!dragging) return;
    e.preventDefault();

    const dx = e.clientX - dragRef.current.x;
    const dy = e.clientY - dragRef.current.y;

    setView((prev) => ({
      ...prev,
      x: dragRef.current.viewX + dx,
      y: dragRef.current.viewY + dy,
    }));
  }

  function onPointerUp(e) {
    setDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Pointer capture may already be released by the browser.
    }
  }

  function onWheel(e) {
    e.preventDefault();

    const rect = e.currentTarget.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    setView((prev) => {
      const nextScale = Math.min(2, Math.max(0.25, prev.scale * (e.deltaY > 0 ? 0.9 : 1.1)));

      return {
        scale: nextScale,
        x: mouseX - ((mouseX - prev.x) / prev.scale) * nextScale,
        y: mouseY - ((mouseY - prev.y) / prev.scale) * nextScale,
      };
    });
  }

  useEffect(() => {
    let stopped = false;

    async function loadSkillTree() {
      const rows = await apiGet("/api/teaching/skill-tree", []);
      if (stopped) return;
      setSkills(Array.isArray(rows) ? rows : []);
      setStatus("");
    }

    loadSkillTree();

    return () => {
      stopped = true;
    };
  }, []);

  useEffect(() => {
    if (skills.length > 0) {
      requestAnimationFrame(fitToScreen);
    }
  }, [fitToScreen, skills.length]);

  return (
    <section style={{ ...panelStyle, overflow: "hidden" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 10 }}>
        <h2 style={{ margin: 0, color: "#0f172a", fontSize: 18 }}>完整技能树</h2>
        <span style={{ color: "#64748b", fontSize: 12 }}>{skills.length} 个节点</span>
      </div>

      <div
        ref={viewportRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        style={{
          border: "1px solid #e2e8f0",
          borderRadius: 14,
          background: "#fafbfc",
          overflow: "hidden",
          minHeight: 420,
          height: "calc(100vh - 230px)",
          position: "relative",
          cursor: dragging ? "grabbing" : "grab",
          touchAction: "none",
          userSelect: "none",
          WebkitUserSelect: "none",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 10,
            right: 10,
            zIndex: 10,
            display: "flex",
            gap: 6,
            background: "rgba(255,255,255,.88)",
            border: "1px solid #e2e8f0",
            borderRadius: 999,
            padding: 5,
            boxShadow: "0 8px 20px rgba(15,23,42,.08)",
            userSelect: "none",
            WebkitUserSelect: "none",
          }}
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onWheel={(e) => e.stopPropagation()}
        >
          <button type="button" onClick={() => zoomBy(0.1)} style={zoomBtnStyle}>＋</button>
          <button type="button" onClick={() => zoomBy(-0.1)} style={zoomBtnStyle}>－</button>
          <button type="button" onClick={fitToScreen} style={zoomBtnStyle}>适应</button>
        </div>

        {status && <div style={{ color: "#64748b", fontSize: 13, padding: 14 }}>{status}</div>}

        {!status && skills.length === 0 && (
          <div style={{ color: "#94a3b8", fontSize: 13, padding: 14 }}>暂无技能树</div>
        )}

        {skills.length > 0 && (
          <div
            style={{
              position: "absolute",
              left: view.x,
              top: view.y,
              width: tree.width,
              height: tree.height,
              transform: `scale(${view.scale})`,
              transformOrigin: "0 0",
            }}
          >
            <svg
              width={tree.width}
              height={tree.height}
              style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
            >
              {skills
                .filter((skill) => skill.parent_id)
                .map((skill) => {
                  const parent = tree.layout.get(skill.parent_id);
                  const child = tree.layout.get(skill.id);
                  if (!parent || !child) return null;

                  const x1 = parent.x + NODE_W;
                  const y1 = parent.y + parent.h / 2;
                  const x2 = child.x;
                  const y2 = child.y + child.h / 2;
                  const midX = x1 + Math.max(26, (x2 - x1) / 2);

                  return (
                    <path
                      key={`${skill.parent_id}-${skill.id}`}
                      d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`}
                      fill="none"
                      stroke="#cbd5e1"
                      strokeWidth="1.5"
                    />
                  );
                })}
            </svg>

            {[...tree.layout.values()].map((item) => (
              <SkillNode key={item.skill.id} skill={item.skill} pos={item} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
