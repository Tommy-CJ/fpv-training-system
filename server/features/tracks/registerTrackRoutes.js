import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function registerTrackRoutes({
  app,
  bracketStateFile,
  calculateTransportPlans,
  db,
  defaultTransportRules,
  readJsonIfExists,
  runTransaction,
  trackUploadsDir,
  upsertTransportRule,
}) {
let bracketStateCache = null;
let bracketStateCacheLoaded = false;
const DEFAULT_TRANSPORT_RULES = defaultTransportRules;
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
    trackImageUrl: row.track_image_url || "",
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

function getLessonTrackRow() {
  const currentTrackId = getCurrentTrackId();
  const currentTrackRow = currentTrackId ? getTrackRow(currentTrackId) : null;
  if (currentTrackRow?.track_image_url) return currentTrackRow;
  return db.prepare(`
    SELECT * FROM tracks
    WHERE track_image_url IS NOT NULL AND track_image_url <> ''
    ORDER BY updated_at DESC
    LIMIT 1
  `).get() || currentTrackRow;
}

function trackSummary(trackId) {
  const rows = equipmentRows(trackId);
  return rows
    .filter((row) => Number(row.final_quantity) > 0)
    .map((row) => `${equipmentLabel(row.equipment_type)} ${row.final_quantity}`)
    .join(" / ");
}

function equipmentLabel(type) {
  if (type === "flag") return "\u5200\u65d7";
  return ({
    single: "\u5355\u95e8",
    sun: "\u65e5\u5b57\u95e8",
    gravity: "\u91cd\u529b\u95e8",
    doubleGravity: "\u53cc\u5c42\u91cd\u529b\u95e8",
    triple: "\u4e09\u5c42\u95e8",
    sandbag: "\u6c99\u5305",
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
  if (kind === "divegate") return "gravity";
  if (kind === "gate") return "single";
  if (kind === "flag") return "flag";
  if (kind === "tower") return "sun";
  if (kind === "ladder") return "triple";
  const text = objectSearchText(object);
  if (!text) return "";
  if (/startfinish|start_finish|polyline/.test(text)) return "__ignore";
  if (/\bflag\b|刀旗/.test(text)) return "flag";
  if (/sandbag|沙包/.test(text)) return "sandbag";
  if (/triple|\u4e09\u5c42|\u76ee\u5b57/.test(text)) return "triple";
  if (/double|\u53cc\u5c42/.test(text)) return "doubleGravity";
  if (/sun|日字|tower/.test(text)) return "sun";
  if (/triple|\u4e09\u5c42|\u76ee\u5b57/.test(text)) return "triple";
  if (/gravity|\u91cd\u529b/.test(text)) return "gravity";
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

function findDoubleGravityGroups(objects, equipmentKind) {
  const candidates = objects
    .map((item, index) => ({ item, index, key: objectIdentity(item, index), position: objectPosition(item.raw) }))
    .filter((entry) => String(entry.item.raw?.kind || "").toLowerCase() === equipmentKind && entry.position);
  const consumed = new Set();
  let groups = 0;

  for (const anchor of candidates) {
    if (consumed.has(anchor.key)) continue;
    const nearby = candidates
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
  const ladderGroups = findDoubleGravityGroups(objects, "ladder");
  const towerGroups = findDoubleGravityGroups(objects, "tower");
  const doubleGravityObjectIds = new Set([...ladderGroups.consumed, ...towerGroups.consumed]);
  counts.doubleGravity += ladderGroups.groups + towerGroups.groups;
  for (const [index, item] of objects.entries()) {
    if (doubleGravityObjectIds.has(objectIdentity(item, index))) continue;
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
    const error = new Error("TrackDraw API Key \u672a\u914d\u7f6e");
    error.statusCode = 401;
    error.userMessage = "API Key 无效";
    throw error;
  }
  const response = await fetch(`${TRACKDRAW_BASE_URL}${pathname}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    let detail;
    try {
      const problem = await response.json();
      detail = problem.detail || problem.title || "";
    } catch {
      detail = await response.text().catch(() => "");
    }
    const error = new Error(detail || `TrackDraw HTTP ${response.status}`);
    error.statusCode = response.status;
    if (response.status === 401 || response.status === 403) error.userMessage = "API Key 无效";
    else if (response.status === 404) error.userMessage = "\u9879\u76ee\u4e0d\u5b58\u5728";
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
      (id, name, location, note, trackdraw_project_id, trackdraw_embed_url, track_image_url, sync_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(
    id,
    String(req.body?.name || projectId || "\u672a\u540c\u6b65\u8d5b\u9053").trim(),
    "",
    "",
    projectId,
    normalizeTrackdrawEmbedUrl(embedUrl, projectId),
    String(req.body?.trackImageUrl || "").trim(),
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
    SET name = ?, location = ?, note = ?, trackdraw_project_id = ?, trackdraw_embed_url = ?, track_image_url = ?, updated_at = ?
    WHERE id = ?
  `).run(
    String(req.body?.name || row.name || projectId || "\u672a\u540c\u6b65\u8d5b\u9053").trim(),
    "",
    "",
    projectId,
    normalizeTrackdrawEmbedUrl(embedUrl, projectId),
    String(req.body?.trackImageUrl ?? row.track_image_url ?? "").trim(),
    now,
    req.params.id,
  );
  res.json({ ok: true, track: trackFromRow(getTrackRow(req.params.id), { includeChildren: true }) });
});

app.post("/api/tracks/:id/image", (req, res) => {
  const row = getTrackRow(req.params.id);
  if (!row) return res.status(404).json({ error: "track not found" });
  const dataUrl = String(req.body?.dataUrl || "");
  const match = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i.exec(dataUrl);
  if (!match) return res.status(400).json({ error: "图片格式错误" });
  const ext = match[1].toLowerCase() === "jpeg" ? "jpg" : match[1].toLowerCase();
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > 8 * 1024 * 1024) return res.status(400).json({ error: "图片大小需小于 8MB" });
  const fileName = `${req.params.id}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.${ext}`;
  const filePath = path.join(trackUploadsDir, fileName);
  fs.writeFileSync(filePath, buffer);
  const url = `/uploads/tracks/${fileName}`;
  db.prepare("UPDATE tracks SET track_image_url = ?, updated_at = ? WHERE id = ?").run(url, Date.now(), req.params.id);
  res.json({ ok: true, trackImageUrl: url, track: trackFromRow(getTrackRow(req.params.id), { includeChildren: true }) });
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

return { getLessonTrackRow, settingJson, setSettingJson, trackFromRow };
}
