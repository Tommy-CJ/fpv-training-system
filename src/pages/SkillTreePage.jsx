import { useEffect, useMemo, useRef, useState } from "react";
import { apiGet, buttonStyle, inputStyle, panelStyle, primaryButtonStyle } from "../trainingShared.js";
import { getCoachPassword } from "../authConfig.js";

// 视觉参数：思维导图节点宽度，节点文字太挤时优先调这里。
const NODE_W = 172;
// 视觉参数：基础节点高度，星级行会在此基础上增加高度。
const NODE_H = 68;
// 视觉参数：父子节点横向间距，影响树的横向展开密度。
const H_GAP = 80;
// 视觉参数：同级节点纵向间距，树太高时可适当调小。
const V_GAP = 20;
// 视觉参数：画布内部留白，避免节点贴住固定视口边缘。
const CANVAS_PAD = 48;

const FILLED_STAR_COLOR = "#facc15";
const EMPTY_STAR_COLOR = "#d4d4d8";

// ── 辅助 ────────────────────────────────────────────────────────────
async function apiPostCoach(path, data) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-coach-password": getCoachPassword() },
    body: JSON.stringify(data),
  });
  if (!r.ok) {
    const t = await r.text();
    let m = t;
    try { const p = JSON.parse(t); m = p.error || p.message || t; } catch { /* raw */ }
    throw new Error(m);
  }
  return r.json();
}

// ── 星星组件 ─────────────────────────────────────────────────────────
function StarRow({ stars, max = 5, size = 13, showEmpty = true }) {
  return (
    <span style={{ display: "inline-flex", gap: 1, verticalAlign: "middle", lineHeight: 1 }}>
      {Array.from({ length: max }, (_, i) => (
        <span key={i} style={{
          color: i < stars ? FILLED_STAR_COLOR : (showEmpty ? EMPTY_STAR_COLOR : "transparent"),
          fontSize: size,
        }}>★</span>
      ))}
    </span>
  );
}

// ── 树形布局（改进版：每个分支独立区域）─────────────────────────────────
function computeLayout(nodes) {
  // 构建树
  const childrenMap = {};
  for (const n of nodes) {
    const pid = n.parent_id || "__root__";
    if (!childrenMap[pid]) childrenMap[pid] = [];
    childrenMap[pid].push(n);
  }

  const layout = {}; // id -> { x, y, w, h }

  // 递归布局：返回该子树占用的总高度
  function layoutSubtree(nodeId, depth, topY) {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return { h: 0 };

    const hasStars = Array.isArray(node.star_criteria) && node.star_criteria.length > 0;
    const myH = NODE_H + (hasStars ? 16 : 0);
    const myX = depth * (NODE_W + H_GAP);
    const kids = childrenMap[nodeId] || [];

    if (kids.length === 0) {
      // 叶子：占据 myH 高度
      layout[nodeId] = { x: myX, y: topY, w: NODE_W, h: myH };
      return { h: myH };
    }

    // 先递归布局所有子节点，累计它们占用的高度
    let childTop = topY;
    kids.forEach((kid) => {
      const res = layoutSubtree(kid.id, depth + 1, childTop);
      childTop += res.h + V_GAP;
    });

    // 子树高度 = 所有子节点 + 间距（去掉最后一个间距）
    const subtreeH = childTop - topY - V_GAP;

    // 父节点垂直居中于子节点区域，但不低于 topY（防止跑到子节点上方导致连线断裂）
    const firstCenter = layout[kids[0].id].y + layout[kids[0].id].h / 2;
    const lastCenter = layout[kids[kids.length - 1].id].y + layout[kids[kids.length - 1].id].h / 2;
    const centerY = (firstCenter + lastCenter) / 2;
    const myY = Math.max(topY, centerY - myH / 2);

    layout[nodeId] = { x: myX, y: myY, w: NODE_W, h: myH };

    // 返回值 = max(父节点底部, 子节点区域底部) - topY
    const myBottom = myY + myH;
    const kidsBottom = topY + subtreeH;
    return { h: Math.max(myBottom, kidsBottom) - topY };
  }

  // 处理所有根节点：垂直排列，每个 root 用独立 rootTop 起点
  let rootTop = 30;
  for (const root of childrenMap["__root__"] || []) {
    const res = layoutSubtree(root.id, 0, rootTop);
    rootTop += res.h + 60;
  }

  // 计算画布尺寸
  let maxX = 800, maxY = 500;
  for (const pos of Object.values(layout)) {
    maxX = Math.max(maxX, pos.x + NODE_W + 80);
    maxY = Math.max(maxY, pos.y + pos.h + 60);
  }

  return { layout, canvasW: maxX, canvasH: maxY };
}

// ── 节点 ─────────────────────────────────────────────────────────────
function MindNode({ node, pos, selected, isRoot, onSelect, onAddChild, onDelete, onEdit, onStartDrag }) {
  const hasStars = Array.isArray(node.star_criteria) && node.star_criteria.length > 0;
  const displayStars = hasStars ? 5 : 0;
  const isCategory = !node.parent_id;
  const bg = selected ? "#dbeafe" : (isCategory ? "#f0f4ff" : "#fff");
  const border = selected ? "2px solid #2563eb" : (isCategory ? "2px solid #93c5fd" : "1px solid #d4d4d8");

  return (
    <div
      style={{
        position: "absolute",
        left: pos.x,
        top: pos.y,
        width: NODE_W,
        minHeight: pos.h - 4,
        background: bg,
        border,
        borderRadius: 12,
        padding: "6px 10px",
        boxShadow: selected ? "0 4px 16px rgba(37,99,235,0.18)" : "0 2px 8px rgba(0,0,0,0.05)",
        cursor: "pointer",
        userSelect: "none",
        zIndex: selected ? 8 : 1,
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
      onClick={(e) => { e.stopPropagation(); onSelect(node.id); }}
      onDoubleClick={(e) => { e.stopPropagation(); onEdit(node); }}
      onMouseDown={(e) => {
        if (e.target.tagName === "BUTTON" || (e.target.tagName === "SPAN" && e.target.closest("button"))) return;
        onStartDrag(e);
      }}
    >
      {!isRoot && (
        <button type="button" onClick={(e) => { e.stopPropagation(); onDelete(node); }} title="删除此节点"
          style={{
            position: "absolute", top: -8, right: -8, width: 22, height: 22,
            borderRadius: 11, border: "1px solid #fecaca", background: "#fef2f2",
            color: "#b91c1c", fontSize: 14, fontWeight: 900,
            cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
            lineHeight: 1, padding: 0,
          }}>×</button>
      )}
      <div style={{
        fontWeight: isCategory ? 900 : 700, fontSize: isCategory ? 14 : 13,
        color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>{node.name}</div>
      {hasStars && (
        <div style={{ marginTop: 2 }}>
          <StarRow stars={displayStars} size={13} />
        </div>
      )}
      <button type="button" onClick={(e) => { e.stopPropagation(); onAddChild(node); }} title="添加子节点"
        style={{
          position: "absolute", bottom: -10, right: NODE_W / 2 - 11, width: 22, height: 22,
          borderRadius: 11, border: "1px solid #bbf7d0", background: "#f0fdf4",
          color: "#15803d", fontSize: 16, fontWeight: 900,
          cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
          lineHeight: 1, padding: 0,
        }}>+</button>
    </div>
  );
}

// ── 连线 ─────────────────────────────────────────────────────────────
function Connectors({ nodes, layout }) {
  const lines = [];
  for (const node of nodes) {
    if (!node.parent_id) continue;
    const parentPos = layout[node.parent_id];
    const childPos = layout[node.id];
    if (!parentPos || !childPos) continue;
    const x1 = parentPos.x + NODE_W;
    const y1 = parentPos.y + parentPos.h / 2;
    const x2 = childPos.x;
    const y2 = childPos.y + childPos.h / 2;
    const midX = x1 + Math.max(30, (x2 - x1) / 2);
    lines.push({
      key: `${node.parent_id}->${node.id}`,
      d: `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`,
    });
  }
  return (
    <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 0 }}>
      {lines.map((l) => (
        <path key={l.key} d={l.d} fill="none" stroke="#cbd5e1" strokeWidth={1.5} />
      ))}
    </svg>
  );
}

// ── 星标编辑面板 ──────────────────────────────────────────────────────
function StarEditor({ criteria, onChange }) {
  const items = Array.isArray(criteria) ? criteria : [];
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div style={{ fontWeight: 900, color: "#0f172a", fontSize: 13 }}>星标达标标准</div>
      {[1, 2, 3, 4, 5].map((star) => {
        const item = items.find((x) => x.star === star) || { star, criterion: "" };
        return (
          <div key={star} style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ color: FILLED_STAR_COLOR, fontWeight: 900, fontSize: 13, minWidth: 20 }}>★{star}</span>
            <input type="text" value={item.criterion}
              onChange={(e) => {
                const next = items.filter((x) => x.star !== star);
                if (e.target.value.trim()) next.push({ star, criterion: e.target.value });
                next.sort((a, b) => a.star - b.star);
                onChange(next);
              }}
              placeholder={`第${star}星标准...`}
              style={{ ...inputStyle, flex: 1, height: 32, fontSize: 12 }} />
          </div>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
export default function SkillTreePage() {
  const [allNodes, setAllNodes] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({ name: "", description: "", star_criteria: [] });
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [addParentId, setAddParentId] = useState(null);
  const [addName, setAddName] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState("");
  const [zoom, setZoom] = useState(1);
  const [drag, setDrag] = useState(null);
  const [pan, setPan] = useState({ x: 24, y: 24 });
  const [panelOpen, setPanelOpen] = useState(true);

  const canvasRef = useRef(null);
  const fileRef = useRef(null);

  // ── 加载 ──────────────────────────────────────────────────────────
  async function load() {
    const rows = await apiGet("/api/teaching/skill-tree", []);
    setAllNodes(rows);
  }

  useEffect(() => {
    let stopped = false;
    async function loadOnce() {
      const rows = await apiGet("/api/teaching/skill-tree", []);
      if (!stopped) setAllNodes(rows);
    }
    loadOnce();
    return () => {
      stopped = true;
    };
  }, []);

  // ── 布局 ──────────────────────────────────────────────────────────
  const { layout, canvasW, canvasH } = computeLayout(allNodes);
  const roots = useMemo(() => allNodes.filter((r) => !r.parent_id), [allNodes]);
  const childrenByParent = useMemo(() => {
    const map = new Map();
    for (const node of allNodes) {
      const key = node.parent_id || "__root__";
      const list = map.get(key) || [];
      list.push(node);
      map.set(key, list);
    }
    return map;
  }, [allNodes]);

  // ── 选中的节点 ────────────────────────────────────────────────────
  const selectedNode = allNodes.find((n) => n.id === selectedId) || null;

  // ── CRUD ──────────────────────────────────────────────────────────
  async function saveNode(form, id) {
    await apiPostCoach("/api/teaching/skill-tree", { ...form, id });
    await load();
  }

  async function handleAddChild(parentNode) {
    setAddParentId(parentNode?.id || null);
    setAddName("");
    setShowAddDialog(true);
  }

  async function submitAddChild() {
    if (!addName.trim()) return;
    const parent = allNodes.find((n) => n.id === addParentId);
    await saveNode({
      name: addName.trim(),
      category: parent?.category || parent?.name || addName.trim(),
      parent_id: addParentId,
      star_criteria: [],
    });
    setShowAddDialog(false);
  }

  async function handleDelete(node) {
    if (!window.confirm(`确定删除「${node.name}」及其所有子节点？`)) return;
    const response = await fetch(`/api/teaching/skill-tree/${node.id}`, {
      method: "DELETE",
      headers: { "x-coach-password": getCoachPassword() },
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      window.alert(payload.error || "删除失败");
      return;
    }
    if (selectedId === node.id) setSelectedId(null);
    if (editingId === node.id) setEditingId(null);
    await load();
  }

  function handleEdit(node) {
    setEditingId(node.id);
    setEditForm({
      name: node.name,
      description: node.description || "",
      star_criteria: Array.isArray(node.star_criteria) ? JSON.parse(JSON.stringify(node.star_criteria)) : [],
    });
  }

  async function submitEdit() {
    if (!editForm.name.trim()) return;
    const node = allNodes.find((n) => n.id === editingId);
    await saveNode({
      name: editForm.name.trim(),
      category: node?.category || "",
      description: editForm.description,
      star_criteria: editForm.star_criteria,
      parent_id: node?.parent_id || null,
    }, editingId);
    setEditingId(null);
  }

  // ── 导入导出 ──────────────────────────────────────────────────────
  function buildExportTree(nodes, parentId) {
    const kids = nodes.filter((n) => n.parent_id === parentId);
    return kids.map((k) => ({
      name: k.name,
      id: k.id,
      description: k.description || undefined,
      star_criteria: k.star_criteria?.length ? k.star_criteria : undefined,
      children: buildExportTree(nodes, k.id),
    }));
  }

  function handleExport() {
    const tree = buildExportTree(allNodes, null);
    const blob = new Blob([JSON.stringify({ skills: tree }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `skill-tree-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleImport() {
    setImportError("");
    let data;
    try { data = JSON.parse(importText); } catch { setImportError("JSON 格式错误"); return; }
    const nodes = data.skills || data.categories;
    if (!Array.isArray(nodes)) { setImportError('需要 { "skills": [...] } 或 { "categories": [...] }'); return; }
    try {
      const r = await fetch("/api/teaching/skill-tree/import", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-coach-password": getCoachPassword() },
        body: JSON.stringify(data),
      });
      if (!r.ok) { const j = await r.json(); throw new Error(j.error || "导入失败"); }
      await load();
      setShowImport(false);
      setImportText("");
    } catch (err) { setImportError(err.message); }
  }

  function handleFileImport(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { setImportText(ev.target.result); setShowImport(true); };
    reader.readAsText(file);
  }

  // ── 拖拽画布 ──────────────────────────────────────────────────────
  function handleCanvasMouseDown(e) {
    // 按钮、输入框不触发拖拽
    if (e.target.tagName === "BUTTON" || e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    setDrag({ sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y });
  }

  function handleCanvasMouseMove(e) {
    if (!drag) return;
    setPan({
      x: drag.px + e.clientX - drag.sx,
      y: drag.py + e.clientY - drag.sy,
    });
  }

  useEffect(() => {
    if (!drag) return;
    const up = () => setDrag(null);
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, [drag]);

  function startNodeDrag(e) {
    e.stopPropagation();
    setDrag({ sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y });
  }

  function renderDirectoryNodes(parentId, depth = 0) {
    const nodes = childrenByParent.get(parentId || "__root__") || [];
    return nodes.map((node) => (
      <div key={node.id} style={{ marginBottom: depth === 0 ? 6 : 2 }}>
        <div
          onClick={() => setSelectedId(node.id)}
          style={{
            padding: depth === 0 ? "6px 10px" : "4px 8px",
            paddingLeft: depth === 0 ? 10 : Math.min(10 + depth * 14, 46),
            borderRadius: 8,
            cursor: "pointer",
            background: selectedId === node.id ? "#dbeafe" : "transparent",
            fontWeight: depth === 0 ? 800 : 650,
            color: depth === 0 ? "#1e293b" : "#475569",
            fontSize: depth === 0 ? 13 : 12,
            display: "grid",
            gridTemplateColumns: "minmax(0,1fr) auto",
            gap: 4,
            alignItems: "center",
          }}
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.name}</span>
          <StarRow stars={Array.isArray(node.star_criteria) && node.star_criteria.length ? 5 : 0} size={11} showEmpty={false} />
        </div>
        {renderDirectoryNodes(node.id, depth + 1)}
      </div>
    ));
  }

  // ── 渲染 ──────────────────────────────────────────────────────────
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: panelOpen
          ? "240px minmax(360px,1fr) 210px"
          : "240px minmax(360px,1fr) 28px",
        gap: 10,
        height: "66vh",
        minHeight: 420,
        maxHeight: "calc(100vh - 185px)",
        overflow: "hidden",
        alignItems: "stretch",
      }}
    >
      {/* 左侧目录 */}
      <div style={{ ...panelStyle, overflow: "auto", minWidth: 0 }}>
        <div style={{ fontWeight: 900, fontSize: 15, marginBottom: 10, color: "#0f172a" }}>技能树目录</div>
        {roots.length === 0 && (
          <div style={{ color: "#94a3b8", fontSize: 13, lineHeight: 1.6, padding: "16px 4px" }}>
            暂无技能节点，先创建一个根节点。
          </div>
        )}
        {renderDirectoryNodes(null)}
        <button type="button" style={{ ...primaryButtonStyle, width: "100%", height: 30, fontSize: 12, marginTop: 6 }}
          onClick={() => { setAddParentId(null); setAddName(""); setShowAddDialog(true); }}>
          + 新根节点
        </button>
        <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" }}>
          <button type="button" style={{ ...buttonStyle, flex: 1, height: 28, fontSize: 11 }} onClick={handleExport}>导出</button>
          <button type="button" style={{ ...buttonStyle, flex: 1, height: 28, fontSize: 11 }} onClick={() => fileRef.current?.click()}>导入</button>
          <input ref={fileRef} type="file" accept=".json" style={{ display: "none" }} onChange={handleFileImport} />
        </div>
      </div>

      {/* 中间画布 */}
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: "#64748b" }}>缩放：{Math.round(zoom * 100)}%</span>
          <button type="button" style={{ ...buttonStyle, height: 24, fontSize: 11, padding: "0 8px" }}
            onClick={() => setZoom((z) => Math.max(0.3, z - 0.15))}>−</button>
          <button type="button" style={{ ...buttonStyle, height: 24, fontSize: 11, padding: "0 8px" }}
            onClick={() => setZoom((z) => Math.min(2.5, z + 0.15))}>+</button>
          <button type="button" style={{ ...buttonStyle, height: 24, fontSize: 11, padding: "0 8px" }}
            onClick={() => { setZoom(1); setPan({ x: 24, y: 24 }); }}>重置</button>
        </div>
        <div
          ref={canvasRef}
          className="canvas-bg"
          onMouseDown={handleCanvasMouseDown}
          onMouseMove={handleCanvasMouseMove}
          style={{
            flex: 1, overflow: "hidden", borderRadius: 16, background: "#fafbfc",
            border: "1px solid #e5e7eb", position: "relative", cursor: drag ? "grabbing" : "grab", minHeight: 0,
          }}
        >
          <div style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: canvasW + CANVAS_PAD,
            height: canvasH + CANVAS_PAD,
            transformOrigin: "top left",
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          }}>
            {allNodes.length === 0 && (
              <div style={{ ...panelStyle, position: "absolute", left: 80, top: 80, width: 260, color: "#64748b", textAlign: "center", lineHeight: 1.7 }}>
                技能树为空。点击左侧「+ 新根节点」开始创建。
              </div>
            )}
            <Connectors nodes={allNodes} layout={layout} />
            {allNodes.map((node) => {
              const pos = layout[node.id];
              if (!pos) return null;
              return (
                <MindNode key={node.id}
                  node={node}
                  pos={pos}
                  selected={selectedId === node.id}
                  isRoot={!node.parent_id}
                  onSelect={setSelectedId}
                  onAddChild={handleAddChild}
                  onDelete={handleDelete}
                  onEdit={handleEdit}
                  onStartDrag={startNodeDrag}
                />
              );
            })}
          </div>
        </div>
      </div>

      {/* 右侧属性面板 */}
      {panelOpen ? (
        <div style={{ ...panelStyle, position: "relative", overflow: "auto", minWidth: 0 }}>
          <button type="button" onClick={() => setPanelOpen(false)}
            style={{ position: "absolute", top: 8, right: 8, width: 22, height: 22, borderRadius: 4, border: "1px solid #d4d4d8", background: "#fff", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 0, color: "#64748b", zIndex: 3 }}
            title="折叠面板">◀</button>
          {selectedNode ? (
            <>
          {editingId === selectedNode.id ? (
            <div style={{ display: "grid", gap: 10 }}>
              <div style={{ fontWeight: 900, fontSize: 15, color: "#0f172a" }}>编辑节点</div>
              <input type="text" value={editForm.name}
                onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                style={inputStyle} placeholder="节点名称" />
              <input type="text" value={editForm.description}
                onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
                style={inputStyle} placeholder="描述（可选）" />
              <StarEditor criteria={editForm.star_criteria}
                onChange={(c) => setEditForm((f) => ({ ...f, star_criteria: c }))} />
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" style={{ ...primaryButtonStyle, flex: 1 }} onClick={submitEdit}>保存</button>
                <button type="button" style={buttonStyle} onClick={() => setEditingId(null)}>取消</button>
              </div>
            </div>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              <div style={{ fontWeight: 900, fontSize: 15, color: "#0f172a" }}>{selectedNode.name}</div>
              {selectedNode.description && <div style={{ color: "#475569", fontSize: 13 }}>{selectedNode.description}</div>}
              <div style={{ color: "#64748b", fontSize: 12 }}>类型：{selectedNode.parent_id ? "技能节点" : "根节点"}</div>
              {Array.isArray(selectedNode.star_criteria) && selectedNode.star_criteria.length > 0 && (
                <div>
                  <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 4, color: "#0f172a" }}>星标标准</div>
                  {selectedNode.star_criteria.map((s) => (
                    <div key={s.star} style={{ display: "flex", gap: 6, marginBottom: 3, fontSize: 12 }}>
                      <span style={{ color: FILLED_STAR_COLOR, fontWeight: 900 }}>★{s.star}</span>
                      <span style={{ color: "#475569" }}>{s.criterion}</span>
                    </div>
                  ))}
                </div>
              )}
              <button type="button" style={primaryButtonStyle} onClick={() => handleEdit(selectedNode)}>编辑</button>
              <button type="button" style={{ ...buttonStyle, color: "#b91c1c", borderColor: "#fecaca" }}
                onClick={() => handleDelete(selectedNode)}>删除此节点</button>
            </div>
          )}
        </>
        ) : (
          <div style={{ color: "#94a3b8", fontSize: 13, textAlign: "center", padding: "40px 0" }}>
            点击节点<br />查看详情
          </div>
          )}
        </div>
      ) : (
        <button type="button" onClick={() => setPanelOpen(true)}
          style={{ width: 28, height: "100%", border: "1px solid #d4d4d8", borderRadius: 8, background: "#fff", cursor: "pointer", fontSize: 12, color: "#64748b", writingMode: "vertical-rl", padding: "4px 2px" }}
          title="展开面板">属性面板 ▶</button>
      )}

      {/* 添加子节点弹窗 */}
      {showAddDialog && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => setShowAddDialog(false)}>
          <div style={{ ...panelStyle, width: 360 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontWeight: 900, fontSize: 15, marginBottom: 12, color: "#0f172a" }}>
              {addParentId ? "添加子节点" : "添加根节点"}
            </div>
            <input type="text" value={addName} onChange={(e) => setAddName(e.target.value)}
              style={inputStyle} placeholder="节点名称" autoFocus
              onKeyDown={(e) => { if (e.key === "Enter") submitAddChild(); }} />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 10 }}>
              <button type="button" style={buttonStyle} onClick={() => setShowAddDialog(false)}>取消</button>
              <button type="button" style={primaryButtonStyle} onClick={submitAddChild}>创建</button>
            </div>
          </div>
        </div>
      )}

      {/* 导入弹窗 */}
      {showImport && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => setShowImport(false)}>
          <div style={{ ...panelStyle, width: 500 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontWeight: 900, fontSize: 15, marginBottom: 12, color: "#0f172a" }}>导入技能树 JSON</div>
            <textarea value={importText} onChange={(e) => setImportText(e.target.value)}
              style={{ ...inputStyle, height: 280, resize: "vertical", fontFamily: "monospace", fontSize: 12 }}
              placeholder='{ "skills": [{ "name": "根节点", "children": [...] }] }' />
            {importError && <div style={{ color: "#b91c1c", fontSize: 13, marginTop: 8 }}>{importError}</div>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
              <button type="button" style={buttonStyle} onClick={() => { setShowImport(false); setImportText(""); }}>取消</button>
              <button type="button" style={primaryButtonStyle} onClick={handleImport}>确认导入</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
