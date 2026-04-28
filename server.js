const http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const zlib = require("node:zlib");
const { DatabaseSync } = require("node:sqlite");

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 3100);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const RAW_DATA_DIR = path.join(DATA_DIR, "raw", "fcc");
const FCC_DOWNLOAD_PATH = path.join(RAW_DATA_DIR, "l_amat.zip");
const DB_PATH = path.join(DATA_DIR, "netcheckin.db");
const STT_CACHE_DIR = path.join(DATA_DIR, "torch-cache");
const FCC_AMATEUR_ZIP_URL = "https://data.fcc.gov/download/pub/uls/complete/l_amat.zip";
const OLLAMA_HOST = normalizeOllamaHost(process.env.OLLAMA_HOST || "http://127.0.0.1:11434");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "";
const PYTHON_EXECUTABLE = findPythonExecutable();

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(RAW_DATA_DIR, { recursive: true });
fs.mkdirSync(STT_CACHE_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
initializeDatabase();
const sttWorker = createSttWorker();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    serveStatic(res, url);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`NetCheckin is running at http://${HOST}:${PORT}`);
});

function initializeDatabase() {
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS nets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      frequency TEXT NOT NULL,
      mode TEXT NOT NULL,
      repeater_name TEXT NOT NULL DEFAULT '',
      repeater_offset TEXT NOT NULL DEFAULT '',
      pl_tone TEXT NOT NULL DEFAULT '',
      net_control_callsign TEXT NOT NULL DEFAULT '',
      net_control_name TEXT NOT NULL DEFAULT '',
      net_control_location TEXT NOT NULL DEFAULT '',
      opening_script TEXT NOT NULL DEFAULT '',
      closing_script TEXT NOT NULL DEFAULT '',
      opening_sections TEXT NOT NULL DEFAULT '[]',
      closing_sections TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS stations (
      id TEXT PRIMARY KEY,
      net_id TEXT NOT NULL,
      callsign TEXT NOT NULL,
      location TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      present INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(net_id) REFERENCES nets(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS stations_net_callsign_idx
      ON stations(net_id, callsign);

    CREATE TABLE IF NOT EXISTS callsigns (
      callsign TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'Local database',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  migrateExistingData();
  seedCallsigns();
  seedDefaultNet();
}

function migrateExistingData() {
  const stationColumns = db.prepare("PRAGMA table_info(stations)").all();
  if (!stationColumns.some((column) => column.name === "location")) {
    db.exec("ALTER TABLE stations ADD COLUMN location TEXT NOT NULL DEFAULT ''");
  }
  if (!stationColumns.some((column) => column.name === "sort_order")) {
    db.exec("ALTER TABLE stations ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0");
  }

  const netColumns = db.prepare("PRAGMA table_info(nets)").all();
  if (!netColumns.some((column) => column.name === "opening_sections")) {
    db.exec("ALTER TABLE nets ADD COLUMN opening_sections TEXT NOT NULL DEFAULT '[]'");
  }
  if (!netColumns.some((column) => column.name === "closing_sections")) {
    db.exec("ALTER TABLE nets ADD COLUMN closing_sections TEXT NOT NULL DEFAULT '[]'");
  }
  if (!netColumns.some((column) => column.name === "net_control_callsign")) {
    db.exec("ALTER TABLE nets ADD COLUMN net_control_callsign TEXT NOT NULL DEFAULT ''");
  }
  if (!netColumns.some((column) => column.name === "net_control_name")) {
    db.exec("ALTER TABLE nets ADD COLUMN net_control_name TEXT NOT NULL DEFAULT ''");
  }
  if (!netColumns.some((column) => column.name === "net_control_location")) {
    db.exec("ALTER TABLE nets ADD COLUMN net_control_location TEXT NOT NULL DEFAULT ''");
  }

  const nets = db.prepare(`
    SELECT id, opening_script AS openingScript, closing_script AS closingScript, opening_sections AS openingSections,
      closing_sections AS closingSections
    FROM nets
  `).all();

  const updateScripts = db.prepare(`
    UPDATE nets
    SET opening_sections = ?, closing_sections = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  runInTransaction(() => {
    for (const net of nets) {
      const openingSections = normalizeSections(safeJsonParse(net.openingSections), net.openingScript);
      const closingSections = normalizeSections(safeJsonParse(net.closingSections), net.closingScript);
      updateScripts.run(JSON.stringify(openingSections), JSON.stringify(closingSections), net.id);
    }
  });

  const stations = db.prepare(`
    SELECT id, net_id AS netId
    FROM stations
    ORDER BY net_id, created_at, id
  `).all();

  const updateOrder = db.prepare("UPDATE stations SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
  let currentNetId = null;
  let order = 0;

  runInTransaction(() => {
    for (const station of stations) {
      if (station.netId !== currentNetId) {
        currentNetId = station.netId;
        order = 0;
      }
      updateOrder.run(order, station.id);
      order += 1;
    }
  });

  const stationsMissingLocation = db.prepare(`
    SELECT stations.id AS id, callsigns.location AS location
    FROM stations
    JOIN callsigns ON callsigns.callsign = stations.callsign
    WHERE TRIM(COALESCE(stations.location, '')) = ''
      AND TRIM(COALESCE(callsigns.location, '')) <> ''
  `).all();

  const updateStationLocation = db.prepare(`
    UPDATE stations
    SET location = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  runInTransaction(() => {
    for (const station of stationsMissingLocation) {
      updateStationLocation.run(station.location, station.id);
    }
  });
}

function seedCallsigns() {
  const existing = db.prepare("SELECT COUNT(*) AS count FROM callsigns").get().count;
  if (existing > 0) {
    return;
  }

  const insert = db.prepare(`
    INSERT INTO callsigns (callsign, name, location, source)
    VALUES (?, ?, ?, ?)
  `);

  const rows = [
    ["K9XYZ", "Doug", "Illinois", "Seed data"],
    ["W1AW", "ARRL Headquarters", "Newington, CT", "Seed data"],
    ["N0CALL", "Sample Station", "Test Lab", "Seed data"],
    ["K5TST", "Portable Operator", "Texas", "Seed data"],
  ];

  runInTransaction(() => {
    for (const row of rows) {
      insert.run(...row);
    }
  });
}

function seedDefaultNet() {
  const existing = db.prepare("SELECT COUNT(*) AS count FROM nets").get().count;
  if (existing > 0) {
    return;
  }

  const now = new Date();
  const netId = randomUUID();
  db.prepare(`
    INSERT INTO nets (
      id, name, date, time, frequency, mode, repeater_name, repeater_offset, pl_tone,
      opening_script, closing_script, opening_sections, closing_sections
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    netId,
    "Weekly Club Net",
    now.toISOString().slice(0, 10),
    `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
    "146.940 MHz",
    "repeater",
    "Club Repeater",
    "-0.600 MHz",
    "103.5 Hz",
    "Good evening. This is the weekly club net. Net control is now taking check-ins.",
    "This concludes tonight's net. Thank you to all stations who participated.",
    JSON.stringify([{ id: randomUUID(), text: "Good evening. This is the weekly club net. Net control is now taking check-ins." }]),
    JSON.stringify([{ id: randomUUID(), text: "This concludes tonight's net. Thank you to all stations who participated." }])
  );

  const insertStation = db.prepare(`
    INSERT INTO stations (id, net_id, callsign, location, note, present, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertStation.run(randomUUID(), netId, "K9XYZ", "Illinois", "Doug", 0, 0);
  insertStation.run(randomUUID(), netId, "W1AW", "Newington, CT", "ARRL", 0, 1);
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/nets") {
    sendJson(res, 200, listNets());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/nets") {
    const payload = await readJson(req);
    const id = upsertNet(payload);
    sendJson(res, 200, { ok: true, id });
    return;
  }

  const reportMatch = matchRoute(url.pathname, "/api/nets/:netId/report.pdf");
  if (req.method === "GET" && reportMatch) {
    const net = getNetById(reportMatch.netId);
    if (!net) {
      sendJson(res, 404, { error: "Net not found." });
      return;
    }

    sendPdf(res, makeReportFileName(net), generateNetReportPdf(net));
    return;
  }

  const stationCollectionMatch = matchRoute(url.pathname, "/api/nets/:netId/stations");
  if (req.method === "POST" && stationCollectionMatch) {
    const payload = await readJson(req);
    const id = insertStation(stationCollectionMatch.netId, payload);
    sendJson(res, 200, { ok: true, id });
    return;
  }

  const stationMatch = matchRoute(url.pathname, "/api/nets/:netId/stations/:stationId");
  if (req.method === "PATCH" && stationMatch) {
    const payload = await readJson(req);
    updateStation(stationMatch.netId, stationMatch.stationId, payload);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "DELETE" && stationMatch) {
    deleteStation(stationMatch.netId, stationMatch.stationId);
    sendJson(res, 204, null);
    return;
  }

  const reorderMatch = matchRoute(url.pathname, "/api/nets/:netId/stations/reorder");
  if (req.method === "POST" && reorderMatch) {
    const payload = await readJson(req);
    reorderStations(reorderMatch.netId, payload.stationIds || []);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/callsigns/lookup") {
    const payload = await readJson(req);
    sendJson(res, 200, lookupCallsign(payload.callsign));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/callsigns/search") {
    const payload = await readJson(req);
    sendJson(res, 200, searchCallsigns(payload.query, payload.limit));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/callsigns/candidates") {
    const payload = await readJson(req);
    sendJson(res, 200, resolveCandidates(payload.callsigns || []));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/callsigns/candidates-from-transcript") {
    const payload = await readJson(req);
    const result = await resolveTranscriptCandidates(payload.transcript || "", payload.callsigns || []);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/callsigns/import-fcc") {
    const fileName = String(req.headers["x-file-name"] || "");
    const body = await readRawBody(req);
    const result = importFccData(fileName, body);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/callsigns/download-fcc") {
    const result = await downloadAndImportFccData();
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/stt/transcribe") {
    const audioBuffer = await readRawBody(req);
    const result = await transcribeAudioBuffer(audioBuffer);
    sendJson(res, 200, result);
    return;
  }

  sendJson(res, 404, { error: "Route not found." });
}

function listNets() {
  const nets = db.prepare(`
    SELECT
      id,
      name,
      date,
      time,
      frequency,
      mode,
      repeater_name AS repeaterName,
      repeater_offset AS repeaterOffset,
      pl_tone AS plTone,
      net_control_callsign AS netControlCallsign,
      net_control_name AS netControlName,
      net_control_location AS netControlLocation,
      opening_script AS openingScript,
      closing_script AS closingScript,
      opening_sections AS openingSections,
      closing_sections AS closingSections
    FROM nets
    ORDER BY date DESC, time DESC, created_at DESC
  `).all();

  const stationQuery = db.prepare(`
    SELECT
      stations.id AS id,
      stations.net_id AS netId,
      stations.callsign AS callsign,
      stations.location AS location,
      stations.note AS note,
      stations.present AS present,
      stations.sort_order AS sortOrder,
      COALESCE(callsigns.name, '') AS name
    FROM stations
    LEFT JOIN callsigns ON callsigns.callsign = stations.callsign
    WHERE stations.net_id = ?
    ORDER BY stations.sort_order ASC, stations.created_at ASC
  `);

  return nets.map((net) => ({
    ...net,
    openingSections: normalizeSections(safeJsonParse(net.openingSections), net.openingScript),
    closingSections: normalizeSections(safeJsonParse(net.closingSections), net.closingScript),
    rollCall: stationQuery.all(net.id).map((station) => ({
      ...station,
      present: Boolean(station.present),
    })),
  }));
}

function getNetById(netId) {
  return listNets().find((net) => net.id === netId) || null;
}

function upsertNet(payload) {
  const net = {
    id: payload.id || randomUUID(),
    name: String(payload.name || "").trim(),
    date: String(payload.date || ""),
    time: String(payload.time || ""),
    frequency: String(payload.frequency || "").trim(),
    mode: payload.mode === "simplex" ? "simplex" : "repeater",
    repeaterName: String(payload.repeaterName || "").trim(),
    repeaterOffset: String(payload.repeaterOffset || "").trim(),
    plTone: String(payload.plTone || "").trim(),
    netControlCallsign: normalizeCallsign(payload.netControlCallsign),
    netControlName: String(payload.netControlName || "").trim(),
    netControlLocation: String(payload.netControlLocation || "").trim(),
    openingSections: normalizeSections(payload.openingSections, payload.openingScript),
    closingSections: normalizeSections(payload.closingSections, payload.closingScript),
  };

  db.prepare(`
    INSERT INTO nets (
      id, name, date, time, frequency, mode, repeater_name, repeater_offset, pl_tone,
      net_control_callsign, net_control_name, net_control_location,
      opening_script, closing_script, opening_sections, closing_sections
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      date = excluded.date,
      time = excluded.time,
      frequency = excluded.frequency,
      mode = excluded.mode,
      repeater_name = excluded.repeater_name,
      repeater_offset = excluded.repeater_offset,
      pl_tone = excluded.pl_tone,
      net_control_callsign = excluded.net_control_callsign,
      net_control_name = excluded.net_control_name,
      net_control_location = excluded.net_control_location,
      opening_script = excluded.opening_script,
      closing_script = excluded.closing_script,
      opening_sections = excluded.opening_sections,
      closing_sections = excluded.closing_sections,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    net.id,
    net.name,
    net.date,
    net.time,
    net.frequency,
    net.mode,
    net.repeaterName,
    net.repeaterOffset,
    net.plTone,
    net.netControlCallsign,
    net.netControlName,
    net.netControlLocation,
    joinSections(net.openingSections),
    joinSections(net.closingSections),
    JSON.stringify(net.openingSections),
    JSON.stringify(net.closingSections)
  );

  return net.id;
}

function insertStation(netId, payload) {
  const callsign = normalizeCallsign(payload.callsign);
  if (!callsign) {
    throw new Error("A callsign is required.");
  }

  const existing = db.prepare(`
    SELECT id, location, note, present
    FROM stations
    WHERE net_id = ? AND callsign = ?
  `).get(netId, callsign);

  if (existing) {
    db.prepare(`
      UPDATE stations
      SET location = ?, note = ?, present = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      payload.location !== undefined ? String(payload.location || "").trim() : existing.location,
      payload.note !== undefined ? String(payload.note || "").trim() : existing.note,
      payload.present !== undefined ? (payload.present ? 1 : 0) : existing.present,
      existing.id
    );
    return existing.id;
  }

  const nextOrder = db.prepare(`
    SELECT COALESCE(MAX(sort_order), -1) + 1 AS nextOrder
    FROM stations
    WHERE net_id = ?
  `).get(netId).nextOrder;

  const id = payload.id || randomUUID();
  db.prepare(`
    INSERT INTO stations (id, net_id, callsign, location, note, present, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    netId,
    callsign,
    String(payload.location || "").trim(),
    String(payload.note || "").trim(),
    payload.present ? 1 : 0,
    nextOrder
  );

  return id;
}

function updateStation(netId, stationId, payload) {
  const current = db.prepare(`
    SELECT location, note, present, sort_order AS sortOrder
    FROM stations
    WHERE id = ? AND net_id = ?
  `).get(stationId, netId);

  if (!current) {
    throw new Error("Station not found.");
  }

  db.prepare(`
    UPDATE stations
    SET
      location = ?,
      note = ?,
      present = ?,
      sort_order = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND net_id = ?
  `).run(
    payload.location !== undefined ? String(payload.location || "").trim() : current.location,
    payload.note !== undefined ? String(payload.note || "").trim() : current.note,
    payload.present !== undefined ? (payload.present ? 1 : 0) : current.present,
    payload.sortOrder !== undefined ? Number(payload.sortOrder) : current.sortOrder,
    stationId,
    netId
  );
}

function deleteStation(netId, stationId) {
  db.prepare("DELETE FROM stations WHERE id = ? AND net_id = ?").run(stationId, netId);
  normalizeStationOrder(netId);
}

function reorderStations(netId, stationIds) {
  const knownStations = db.prepare(`
    SELECT id
    FROM stations
    WHERE net_id = ?
    ORDER BY sort_order ASC, created_at ASC
  `).all(netId).map((station) => station.id);

  if (knownStations.length !== stationIds.length) {
    throw new Error("Station reorder list is incomplete.");
  }

  const knownSet = new Set(knownStations);
  for (const stationId of stationIds) {
    if (!knownSet.has(stationId)) {
      throw new Error("Station reorder list contains an unknown station.");
    }
  }

  const update = db.prepare(`
    UPDATE stations
    SET sort_order = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND net_id = ?
  `);

  runInTransaction(() => {
    stationIds.forEach((stationId, index) => {
      update.run(index, stationId, netId);
    });
  });
}

function normalizeStationOrder(netId) {
  const stationIds = db.prepare(`
    SELECT id
    FROM stations
    WHERE net_id = ?
    ORDER BY sort_order ASC, created_at ASC
  `).all(netId).map((station) => station.id);

  const update = db.prepare(`
    UPDATE stations
    SET sort_order = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND net_id = ?
  `);

  runInTransaction(() => {
    stationIds.forEach((stationId, index) => {
      update.run(index, stationId, netId);
    });
  });
}

function lookupCallsign(callsignInput) {
  const callsign = normalizeCallsign(callsignInput);
  if (!callsign) {
    throw new Error("A callsign is required.");
  }

  const row = db.prepare(`
    SELECT callsign, name, location, source
    FROM callsigns
    WHERE callsign = ?
  `).get(callsign);

  return row ? {
    ...row,
    rank: 100,
    confidence: "high",
  } : {
    callsign,
    name: "",
    location: "",
    source: "Local database",
    rank: 40,
    confidence: "low",
  };
}

function searchCallsigns(queryInput, limitInput = 12) {
  const search = buildCallsignSearch(queryInput);
  if (!search.normalized && !search.hasWildcard) {
    return [];
  }

  const limit = Math.min(Math.max(Number(limitInput) || 25, 1), 50);
  const prefixPattern = `${escapeSqlLike(search.normalized)}%`;
  const containsPattern = `%${escapeSqlLike(search.normalized)}%`;
  const wildcardPattern = search.hasWildcard ? search.likePattern : prefixPattern;
  const exactEnabled = search.hasWildcard ? 0 : 1;
  const wildcardEnabled = search.hasWildcard ? 1 : 0;
  const prefixEnabled = search.hasWildcard ? 0 : 1;
  const containsEnabled = search.hasWildcard ? 0 : 1;

  return db.prepare(`
    SELECT
      callsign,
      name,
      location,
      source,
      CASE
        WHEN ? = 1 AND callsign = ? THEN 100
        WHEN ? = 1 AND callsign LIKE ? ESCAPE '\\' THEN ?
        WHEN ? = 1 AND callsign LIKE ? ESCAPE '\\' THEN 78
        WHEN ? = 1 AND callsign LIKE ? ESCAPE '\\' THEN 55
        ELSE 0
      END AS rank
    FROM callsigns
    WHERE (? = 1 AND callsign = ?)
       OR (? = 1 AND callsign LIKE ? ESCAPE '\\')
       OR (? = 1 AND callsign LIKE ? ESCAPE '\\')
       OR (? = 1 AND callsign LIKE ? ESCAPE '\\')
    ORDER BY
      rank DESC,
      LENGTH(callsign) ASC,
      callsign ASC
    LIMIT ?
  `).all(
    exactEnabled,
    search.normalized,
    wildcardEnabled,
    wildcardPattern,
    search.wildcardRank,
    prefixEnabled,
    prefixPattern,
    containsEnabled,
    containsPattern,
    exactEnabled,
    search.normalized,
    wildcardEnabled,
    wildcardPattern,
    prefixEnabled,
    prefixPattern,
    containsEnabled,
    containsPattern,
    limit
  ).map((row) => ({
    ...row,
    confidence: rankToConfidence(row.rank),
  }));
}

function buildCallsignSearch(queryInput) {
  const raw = String(queryInput || "").toUpperCase().trim();
  const normalized = raw.replace(/[^A-Z0-9]/g, "");
  const wildcardSource = raw.replace(/[^A-Z0-9*?_]/g, "");
  const hasWildcard = /[*?_]/.test(wildcardSource);
  const knownCount = (wildcardSource.match(/[A-Z0-9]/g) || []).length;
  const wildcardCount = (wildcardSource.match(/[*?_]/g) || []).length;
  const likePattern = wildcardSource
    .split("")
    .map((character) => {
      if (character === "*" || character === "%") {
        return "%";
      }
      if (character === "?" || character === "_") {
        return "_";
      }
      return escapeSqlLike(character);
    })
    .join("");

  return {
    normalized,
    hasWildcard,
    likePattern,
    wildcardRank: rankWildcardPattern(knownCount, wildcardCount),
  };
}

function escapeSqlLike(value) {
  return String(value).replace(/[\\%_]/g, (character) => `\\${character}`);
}

function rankWildcardPattern(knownCount, wildcardCount) {
  if (knownCount >= 4 && wildcardCount <= 2) {
    return 92;
  }
  if (knownCount >= 3) {
    return 86;
  }
  if (knownCount >= 2) {
    return 72;
  }
  return 50;
}

function rankToConfidence(rank) {
  if (rank >= 90) {
    return "high";
  }
  if (rank >= 70) {
    return "medium";
  }
  return "low";
}

function resolveCandidates(callsigns) {
  const normalized = [...new Set((callsigns || []).map(normalizeCallsign).filter(Boolean))];
  return normalized.map(lookupCallsign);
}

async function resolveTranscriptCandidates(transcript, callsigns) {
  const parsed = normalizeCandidateList(callsigns);
  if (parsed.length) {
    return {
      candidates: parsed.map(lookupCallsign),
      source: "parser",
      ollamaUsed: false,
    };
  }

  const ollamaResult = await inferCallsignsWithOllama(transcript);
  const inferred = normalizeCandidateList(ollamaResult.callsigns);

  return {
    candidates: inferred.map(lookupCallsign),
    source: inferred.length ? "ollama" : "none",
    ollamaUsed: ollamaResult.used,
    ollamaModel: ollamaResult.model,
    ollamaError: ollamaResult.error,
  };
}

function normalizeCandidateList(callsigns) {
  return [...new Set((callsigns || []).map(normalizeCallsign).filter(isLikelyCallsign))].slice(0, 8);
}

function isLikelyCallsign(callsign) {
  return /^[AKNW][A-Z]?\d[A-Z]{1,3}$/.test(callsign);
}

async function inferCallsignsWithOllama(transcript) {
  const cleanTranscript = String(transcript || "").trim();
  if (!cleanTranscript) {
    return { callsigns: [], used: false, model: "", error: "" };
  }

  try {
    const model = OLLAMA_MODEL || await getDefaultOllamaModel();
    if (!model) {
      return { callsigns: [], used: false, model: "", error: "No Ollama model is available." };
    }

    const response = await postOllamaJson("/api/generate", {
      model,
      stream: false,
      format: "json",
      options: {
        temperature: 0,
        num_predict: 80,
      },
      prompt: [
        "You convert rough speech-to-text output from a ham radio net into possible United States amateur radio callsigns.",
        "The transcript may contain NATO phonetics, partial words, or spacing errors.",
        "Return only JSON with one key named callsigns whose value is an array of uppercase callsign strings.",
        "Use uppercase callsigns only. If no plausible callsign exists, return an empty callsigns array.",
        `Transcript: ${cleanTranscript}`,
      ].join("\n"),
    });

    const parsed = parseOllamaCallsignResponse(response.response);
    return { callsigns: parsed, used: true, model, error: "" };
  } catch (error) {
    return { callsigns: [], used: true, model: OLLAMA_MODEL, error: error.message };
  }
}

async function getDefaultOllamaModel() {
  const response = await postOllamaJson("/api/tags", null, "GET");
  return response.models?.[0]?.name || "";
}

function parseOllamaCallsignResponse(responseText) {
  const parsed = safeJsonParse(responseText);
  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (Array.isArray(parsed?.callsigns)) {
    return parsed.callsigns;
  }

  return String(responseText || "").match(/[AKNW][A-Z]?\d[A-Z]{1,3}/gi) || [];
}

function postOllamaJson(pathname, payload, method = "POST") {
  return new Promise((resolve, reject) => {
    const endpoint = new URL(pathname, OLLAMA_HOST);
    const body = payload ? JSON.stringify(payload) : "";
    const request = http.request(endpoint, {
      hostname: endpoint.hostname,
      port: endpoint.port || 11434,
      path: endpoint.pathname,
      method,
      timeout: 30000,
      headers: body ? {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      } : {},
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Ollama returned HTTP ${response.statusCode}: ${text.slice(0, 120)}`));
          return;
        }

        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new Error("Ollama returned invalid JSON."));
        }
      });
    });

    request.on("timeout", () => {
      request.destroy(new Error("Ollama request timed out."));
    });
    request.on("error", reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

function normalizeOllamaHost(host) {
  const trimmed = String(host || "").trim();
  if (!trimmed) {
    return "http://127.0.0.1:11434";
  }

  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

function importFccData(fileName, content) {
  const upperFileName = String(fileName || "").toUpperCase();
  if (!content || content.length === 0) {
    throw new Error("The selected FCC file is empty.");
  }

  if (upperFileName.endsWith(".ZIP")) {
    return importFccZip(fileName, content);
  }

  const lines = Buffer.isBuffer(content)
    ? content.toString("utf8").split(/\r?\n/).filter(Boolean)
    : String(content || "").split(/\r?\n/).filter(Boolean);

  if (upperFileName.includes("EN")) {
    return importFccEn(lines, fileName);
  }

  if (upperFileName.includes("AM")) {
    return importFccAm(lines, fileName);
  }

  throw new Error("Use an FCC ULS EN or AM data file.");
}

async function downloadAndImportFccData() {
  const startedAt = Date.now();
  console.log(`[FCC] Download/cache started: ${FCC_AMATEUR_ZIP_URL}`);
  const download = await downloadFccZipWithProgress(FCC_AMATEUR_ZIP_URL, FCC_DOWNLOAD_PATH);
  console.log(`[FCC] Download/cache ready: ${formatLogBytes(download.bytes)} in ${formatLogDuration(Date.now() - startedAt)} at ${download.path}.`);

  const zipBuffer = fs.readFileSync(download.path);
  if (!zipBuffer.length) {
    throw new Error("FCC download was empty.");
  }

  const importStartedAt = Date.now();
  console.log("[FCC] Import started.");
  const result = importFccData("l_amat.zip", zipBuffer);
  console.log(`[FCC] Import complete: ${result.imported} records in ${formatLogDuration(Date.now() - importStartedAt)}.`);

  return {
    ...result,
    downloaded: true,
    sourceUrl: FCC_AMATEUR_ZIP_URL,
    bytes: zipBuffer.length,
    cachedPath: download.path,
    resumed: download.resumed,
  };
}

async function downloadFccZipWithProgress(url, destinationPath) {
  const existingBytes = fs.existsSync(destinationPath) ? fs.statSync(destinationPath).size : 0;
  const headers = existingBytes > 0 ? { Range: `bytes=${existingBytes}-` } : {};
  if (existingBytes > 0) {
    console.log(`[FCC] Found partial/local download: ${formatLogBytes(existingBytes)}. Attempting resume.`);
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`FCC download failed with HTTP ${response.status}.`);
  }

  const partial = response.status === 206;
  const append = partial && existingBytes > 0;
  const contentLength = Number(response.headers.get("content-length") || 0);
  const totalBytes = getExpectedDownloadBytes(response, contentLength, append ? existingBytes : 0);
  console.log(`[FCC] Expected download size: ${totalBytes ? formatLogBytes(totalBytes) : "unknown"}.`);

  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(destinationPath, buffer);
    return { path: destinationPath, bytes: buffer.length, resumed: false };
  }

  const reader = response.body.getReader();
  const file = fs.createWriteStream(destinationPath, { flags: append ? "a" : "w" });
  let received = append ? existingBytes : 0;
  let lastLoggedAt = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const chunk = Buffer.from(value);
      file.write(chunk);
      received += chunk.length;

      const now = Date.now();
      if (now - lastLoggedAt > 2000) {
        console.log(`[FCC] Downloaded ${formatLogBytes(received)}${totalBytes ? ` of ${formatLogBytes(totalBytes)}` : ""}.`);
        lastLoggedAt = now;
      }
    }
  } finally {
    await closeWriteStream(file);
  }

  return { path: destinationPath, bytes: fs.statSync(destinationPath).size, resumed: append };
}

function getExpectedDownloadBytes(response, contentLength, existingBytes) {
  const range = response.headers.get("content-range");
  const match = range?.match(/\/(\d+)$/);
  if (match) {
    return Number(match[1]);
  }

  return contentLength ? contentLength + existingBytes : 0;
}

function closeWriteStream(stream) {
  return new Promise((resolve, reject) => {
    stream.end((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function formatLogBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatLogDuration(milliseconds) {
  const seconds = milliseconds / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${(seconds % 60).toFixed(0)}s`;
}

function importFccZip(fileName, zipBuffer) {
  console.log("[FCC] Extracting EN.dat and AM.dat from zip.");
  const enLines = unzipEntry(zipBuffer, "EN.dat").toString("utf8").split(/\r?\n/).filter(Boolean);
  const amLines = unzipEntry(zipBuffer, "AM.dat").toString("utf8").split(/\r?\n/).filter(Boolean);
  console.log(`[FCC] Extracted ${enLines.length} EN rows and ${amLines.length} AM rows.`);

  const enResult = importFccEn(enLines, `${fileName}:EN.dat`);
  console.log(`[FCC] EN import complete: ${enResult.imported} records.`);
  const amResult = importFccAm(amLines, `${fileName}:AM.dat`);
  console.log(`[FCC] AM import complete: ${amResult.imported} records.`);

  return {
    imported: enResult.imported + amResult.imported,
    fileName,
    mode: "ZIP",
    details: {
      enImported: enResult.imported,
      amImported: amResult.imported,
    },
  };
}

function importFccEn(lines, fileName) {
  console.log(`[FCC] EN import started: ${fileName}.`);
  const insert = db.prepare(`
    INSERT INTO callsigns (callsign, name, location, source, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(callsign) DO UPDATE SET
      name = excluded.name,
      location = excluded.location,
      source = excluded.source,
      updated_at = CURRENT_TIMESTAMP
  `);

  let imported = 0;

  runInTransaction(() => {
    for (const line of lines) {
      const fields = line.split("|");
      if (fields[0] !== "EN") {
        continue;
      }

      const callsign = normalizeCallsign(fields[4]);
      if (!callsign) {
        continue;
      }

      const name = buildNameFromEn(fields);
      const location = buildLocation(fields[16], fields[17]);
      insert.run(callsign, name, location, `FCC EN import: ${fileName}`);
      imported += 1;
    }
  });

  return {
    imported,
    fileName,
    mode: "EN",
  };
}

function importFccAm(lines, fileName) {
  console.log(`[FCC] AM import started: ${fileName}.`);
  const insert = db.prepare(`
    INSERT INTO callsigns (callsign, name, location, source, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(callsign) DO UPDATE SET
      name = CASE
        WHEN excluded.name <> '' THEN excluded.name
        ELSE callsigns.name
      END,
      location = callsigns.location,
      source = excluded.source,
      updated_at = CURRENT_TIMESTAMP
  `);

  let imported = 0;

  runInTransaction(() => {
    for (const line of lines) {
      const fields = line.split("|");
      if (fields[0] !== "AM") {
        continue;
      }

      const callsign = normalizeCallsign(fields[4]);
      if (!callsign) {
        continue;
      }

      insert.run(callsign, "", "", `FCC AM import: ${fileName}`);
      imported += 1;
    }
  });

  return {
    imported,
    fileName,
    mode: "AM",
  };
}

function buildNameFromEn(fields) {
  const entityName = String(fields[7] || "").trim();
  if (entityName) {
    return entityName;
  }

  return [fields[8], fields[9], fields[10]]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ");
}

function buildLocation(city, state) {
  return [city, state]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(", ");
}

function normalizeSections(candidateSections, fallbackText = "") {
  if (Array.isArray(candidateSections) && candidateSections.length > 0) {
    return candidateSections.map((section) => ({
      id: String(section?.id || randomUUID()),
      text: String(section?.text || "").trim(),
    }));
  }

  const trimmedFallback = String(fallbackText || "").trim();
  if (!trimmedFallback) {
    return [{ id: randomUUID(), text: "" }];
  }

  return [{ id: randomUUID(), text: trimmedFallback }];
}

function joinSections(sections) {
  return normalizeSections(sections).map((section) => section.text).filter(Boolean).join("\n\n");
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value || "[]");
  } catch {
    return [];
  }
}

function unzipEntry(zipBuffer, targetName) {
  const eocdSignature = 0x06054b50;
  const centralSignature = 0x02014b50;
  const localSignature = 0x04034b50;
  const normalizedTarget = String(targetName || "").replace(/\\/g, "/").toUpperCase();

  let eocdOffset = -1;
  for (let index = zipBuffer.length - 22; index >= Math.max(0, zipBuffer.length - 65557); index -= 1) {
    if (zipBuffer.readUInt32LE(index) === eocdSignature) {
      eocdOffset = index;
      break;
    }
  }

  if (eocdOffset < 0) {
    throw new Error("Unable to read FCC zip archive.");
  }

  const centralDirectoryOffset = zipBuffer.readUInt32LE(eocdOffset + 16);
  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
  let offset = centralDirectoryOffset;

  for (let entryIndex = 0; entryIndex < totalEntries; entryIndex += 1) {
    if (zipBuffer.readUInt32LE(offset) !== centralSignature) {
      throw new Error("Invalid FCC zip central directory.");
    }

    const compressionMethod = zipBuffer.readUInt16LE(offset + 10);
    const compressedSize = zipBuffer.readUInt32LE(offset + 20);
    const fileNameLength = zipBuffer.readUInt16LE(offset + 28);
    const extraLength = zipBuffer.readUInt16LE(offset + 30);
    const commentLength = zipBuffer.readUInt16LE(offset + 32);
    const localHeaderOffset = zipBuffer.readUInt32LE(offset + 42);
    const fileName = zipBuffer
      .slice(offset + 46, offset + 46 + fileNameLength)
      .toString("utf8")
      .replace(/\\/g, "/")
      .toUpperCase();

    if (fileName === normalizedTarget) {
      if (zipBuffer.readUInt32LE(localHeaderOffset) !== localSignature) {
        throw new Error("Invalid FCC zip entry header.");
      }

      const localNameLength = zipBuffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = zipBuffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const compressedData = zipBuffer.slice(dataStart, dataStart + compressedSize);

      if (compressionMethod === 0) {
        return compressedData;
      }

      if (compressionMethod === 8) {
        return zlib.inflateRawSync(compressedData);
      }

      throw new Error(`Unsupported FCC zip compression method: ${compressionMethod}`);
    }

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  throw new Error(`FCC zip archive is missing ${targetName}.`);
}

function normalizeCallsign(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .trim();
}

function makeReportFileName(net) {
  const safeName = String(net.name || "net")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "net";
  return `netcheckin-${safeName}-report.pdf`;
}

function generateNetReportPdf(net) {
  const checkedIn = net.rollCall.filter((station) => station.present);
  const lines = [
    { text: "NetCheckin Station Report", size: 18, gap: 18 },
    { text: `Net: ${net.name || "Untitled net"}`, size: 12 },
    { text: `Date/Time: ${formatNetDateTime(net)}`, size: 12 },
    { text: `Frequency: ${net.frequency || "Not set"}`, size: 12 },
    { text: `Mode: ${formatNetMode(net)}`, size: 12, gap: 16 },
    { text: `Net Control: ${formatNetControl(net)}`, size: 12, gap: 18 },
    { text: `Checked in: ${checkedIn.length} of ${net.rollCall.length}`, size: 12, gap: 20 },
    { text: "Stations Checked In", size: 15, gap: 12 },
    ...formatStationRows(checkedIn, true),
    { text: "Full Roll Call", size: 15, gap: 12 },
    ...formatStationRows(net.rollCall, false),
  ];

  return buildSimplePdf(lines);
}

function formatNetDateTime(net) {
  const date = net.date || "Not set";
  const time = net.time || "Not set";
  return `${date} ${time}`;
}

function formatNetMode(net) {
  if (net.mode === "simplex") {
    return "Simplex";
  }

  const details = [
    net.repeaterName ? `Repeater ${net.repeaterName}` : "Repeater",
    net.repeaterOffset ? `Offset ${net.repeaterOffset}` : "",
    net.plTone ? `PL ${net.plTone}` : "",
  ].filter(Boolean);

  return details.join(" | ");
}

function formatNetControl(net) {
  if (!net.netControlCallsign) {
    return "Not set";
  }

  const details = [
    net.netControlCallsign,
    net.netControlName,
    net.netControlLocation,
  ].filter(Boolean);

  return details.join(" | ");
}

function formatStationRows(stations, emptyMeansNone) {
  if (!stations.length) {
    return [{ text: emptyMeansNone ? "No checked-in stations yet." : "No roll-call stations yet.", size: 11, gap: 16 }];
  }

  return [
    ...stations.map((station, index) => {
      const status = station.present ? "Checked in" : "Roll call";
      const location = station.location ? ` | ${station.location}` : "";
      const note = station.note ? ` | Notes: ${station.note}` : "";
      return { text: `${index + 1}. ${station.callsign} (${status})${location}${note}`, size: 11, gap: 5 };
    }),
    { text: "", size: 11, gap: 16 },
  ];
}

function buildSimplePdf(lines) {
  const pages = paginatePdfLines(lines);
  const objects = [];
  const addObject = (content) => {
    objects.push(content);
    return objects.length;
  };

  const catalogId = addObject("<< /Type /Catalog /Pages 2 0 R >>");
  const pagesId = addObject("");
  const fontId = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pageIds = [];

  for (const page of pages) {
    const content = renderPdfPageContent(page);
    const contentId = addObject(`<< /Length ${Buffer.byteLength(content, "utf8")} >>\nstream\n${content}\nendstream`);
    const pageId = addObject(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  }

  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, "utf8");
}

function paginatePdfLines(lines) {
  const pages = [];
  let page = [];
  let y = 750;

  for (const line of expandPdfLines(lines)) {
    const size = line.size || 11;
    const gap = line.gap ?? 6;
    if (y - size < 54 && page.length) {
      pages.push(page);
      page = [];
      y = 750;
    }

    page.push({ ...line, y });
    y -= size + gap;
  }

  pages.push(page);
  return pages;
}

function expandPdfLines(lines) {
  const expanded = [];
  for (const line of lines) {
    const width = line.size >= 15 ? 58 : 82;
    const wrapped = wrapPdfText(line.text, width);
    wrapped.forEach((text, index) => {
      expanded.push({
        ...line,
        text,
        gap: index === wrapped.length - 1 ? line.gap : 3,
      });
    });
  }
  return expanded;
}

function wrapPdfText(text, maxLength) {
  const words = String(text || " ").split(/\s+/);
  const lines = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxLength && current) {
      lines.push(current);
      current = word;
      continue;
    }
    current = next;
  }

  lines.push(current || " ");
  return lines;
}

function renderPdfPageContent(lines) {
  return lines.map((line) => {
    const size = line.size || 11;
    return `BT /F1 ${size} Tf 54 ${line.y} Td (${escapePdfText(line.text)}) Tj ET`;
  }).join("\n");
}

function escapePdfText(text) {
  return String(text || "").replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

async function transcribeAudioBuffer(audioBuffer) {
  if (!audioBuffer.length) {
    throw new Error("No audio data was received.");
  }

  const tempPath = path.join(DATA_DIR, `capture-${randomUUID()}.wav`);
  fs.writeFileSync(tempPath, audioBuffer);

  try {
    const transcript = await sttWorker.transcribe(tempPath);
    return { transcript };
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

function createSttWorker() {
  let child = null;
  let nextId = 1;
  const pending = new Map();

  function start() {
    if (child) {
      return;
    }

    child = spawn(PYTHON_EXECUTABLE, [path.join(ROOT, "stt_worker.py")], {
      cwd: ROOT,
      env: {
        ...process.env,
        TORCH_HOME: STT_CACHE_DIR,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      let newlineIndex = stdoutBuffer.indexOf("\n");

      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (line) {
          handleWorkerLine(line);
        }
        newlineIndex = stdoutBuffer.indexOf("\n");
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      const text = chunk.trim();
      if (text) {
        console.error(text);
      }
    });

    child.on("exit", () => {
      const error = new Error("The local STT worker stopped unexpectedly.");
      for (const { reject } of pending.values()) {
        reject(error);
      }
      pending.clear();
      child = null;
    });
  }

  function handleWorkerLine(line) {
    let payload;
    try {
      payload = JSON.parse(line);
    } catch {
      return;
    }

    const request = pending.get(payload.id);
    if (!request) {
      return;
    }

    pending.delete(payload.id);
    if (payload.error) {
      request.reject(new Error(payload.error));
      return;
    }

    request.resolve(payload.transcript || "");
  }

  return {
    transcribe(audioPath) {
      start();

      return new Promise((resolve, reject) => {
        const id = nextId;
        nextId += 1;
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ id, audioPath })}\n`);
      });
    },
  };
}

function findPythonExecutable() {
  const candidates = [];
  if (process.env.NETCHECKIN_PYTHON) {
    candidates.push(process.env.NETCHECKIN_PYTHON);
  }

  candidates.push("python");

  const whereResult = spawnSync("where.exe", ["python"], {
    encoding: "utf8",
    windowsHide: true,
  });

  if (whereResult.status === 0) {
    for (const line of whereResult.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
      candidates.push(line);
    }
  }

  candidates.push("C:\\Users\\Doug\\scoop\\apps\\python313\\current\\python.exe");

  for (const candidate of [...new Set(candidates)]) {
    try {
      const result = spawnSync(candidate, ["-c", "import torch, torchaudio"], {
        encoding: "utf8",
        windowsHide: true,
      });
      if (result.status === 0) {
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return "python";
}

function runInTransaction(work) {
  db.exec("BEGIN");

  try {
    work();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function readJson(req) {
  const buffer = await readRawBody(req);
  if (!buffer.length) {
    return {};
  }

  return JSON.parse(buffer.toString("utf8"));
}

async function readRawBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return Buffer.alloc(0);
  }

  return Buffer.concat(chunks);
}

function serveStatic(res, url) {
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = path.normalize(path.join(ROOT, pathname));

  if (!safePath.startsWith(ROOT)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  if (!fs.existsSync(safePath) || fs.statSync(safePath).isDirectory()) {
    sendText(res, 404, "Not found");
    return;
  }

  const extension = path.extname(safePath).toLowerCase();
  const type = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
  }[extension] || "application/octet-stream";

  res.writeHead(200, { "Content-Type": type });
  fs.createReadStream(safePath).pipe(res);
}

function sendJson(res, status, payload) {
  if (status === 204) {
    res.writeHead(204);
    res.end();
    return;
  }

  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendPdf(res, fileName, pdfBuffer) {
  res.writeHead(200, {
    "Content-Type": "application/pdf",
    "Content-Disposition": `inline; filename="${fileName}"`,
    "Content-Length": pdfBuffer.length,
  });
  res.end(pdfBuffer);
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function matchRoute(pathname, pattern) {
  const pathParts = pathname.split("/").filter(Boolean);
  const patternParts = pattern.split("/").filter(Boolean);

  if (pathParts.length !== patternParts.length) {
    return null;
  }

  const params = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const currentPattern = patternParts[index];
    const currentValue = pathParts[index];

    if (currentPattern.startsWith(":")) {
      params[currentPattern.slice(1)] = currentValue;
      continue;
    }

    if (currentPattern !== currentValue) {
      return null;
    }
  }

  return params;
}
