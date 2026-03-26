// ============================================================
// GORILLA SPAM - Baileys Server (v7 - HARDENED)
// v6 +
//   1. resolveWithRetry: backoff apenas no cache (não chama onWhatsApp em loop)
//   2. TTL seletivo: apenas @s.whatsapp.net não-confirmados expiram (LIDs nunca)
//   3. Deduplicação de mensagens: Set persistido em disco (sobrevive restart)
//   4. Fila de mensagens antes do webhook (async, não bloqueia event loop)
//   5. Rate limit por sessão (queue independente por número)
//   6. Métricas de operação expostas em GET /stats
//   7. Cache duplo explícito: @s.whatsapp.net + @lid para mesmo phone
// ============================================================

const express = require("express");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const fs   = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT        = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const AUTH_DIR    = path.join(__dirname, "..", "auth_sessions");
const CACHE_DIR   = fs.existsSync("/data") ? "/data" : __dirname;
const CACHE_FILE  = path.join(CACHE_DIR, "jid_cache.json");
const DEDUP_FILE  = path.join(CACHE_DIR, "dedup.json");
const QUEUE_FILE  = path.join(CACHE_DIR, "queue.log");

const logger   = pino({ level: "warn" });
const sessions = {};

// ═══════════════════════════════════════════════════════════
//  MÉTRICAS
// ═══════════════════════════════════════════════════════════
const stats = {
  messages_received:   0,
  messages_dispatched: 0,
  lid_unresolved:      0,
  lid_resolved:        0,
  lid_migrations:      0,
  dedup_dropped:       0,
  webhook_ok:          0,
  webhook_fail:        0,
  queue_flushed:       0,
  started_at:          new Date().toISOString(),
};

// ═══════════════════════════════════════════════════════════
//  CACHE JID — com TTL seletivo
//
//  jidToPhoneMap[rawJid] = { phone, ts, confirmed }
//    confirmed=true  → LID ou JID validado via sendMessage/contacts.upsert
//    confirmed=false → inferido via onWhatsApp (sujeito a TTL de 7 dias)
//
//  phoneToJidMap[phone] = jid (string)
// ═══════════════════════════════════════════════════════════
const TTL_UNCONFIRMED_MS = 7 * 24 * 60 * 60 * 1000;

let jidToPhoneMap   = {};
let phoneToJidMap   = {};
let jidMigrationLog = {};

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      jidToPhoneMap   = parsed.jidToPhone   || {};
      phoneToJidMap   = parsed.phoneToJid   || {};
      jidMigrationLog = parsed.migrationLog || {};
      // Migra entradas antigas (string pura) para o novo formato de objeto
      for (const [k, v] of Object.entries(jidToPhoneMap)) {
        if (typeof v === "string") {
          jidToPhoneMap[k] = { phone: v, ts: Date.now(), confirmed: false };
        }
      }
      console.log("[cache] Loaded " + Object.keys(jidToPhoneMap).length + " JID mappings");
    }
  } catch (e) {
    console.error("[cache] Load failed:", e.message);
  }
}

let _savePending = false;
function saveCache() {
  if (_savePending) return;
  _savePending = true;
  setImmediate(() => {
    _savePending = false;
    try {
      fs.writeFileSync(
        CACHE_FILE,
        JSON.stringify({ jidToPhone: jidToPhoneMap, phoneToJid: phoneToJidMap, migrationLog: jidMigrationLog }, null, 2),
        "utf8"
      );
    } catch (e) { console.error("[cache] Save failed:", e.message); }
  });
}

// TTL cleanup: apenas entradas não-confirmadas expiram; LIDs são permanentes
function cleanupCache() {
  const now = Date.now();
  let removed = 0;
  for (const [rawJid, entry] of Object.entries(jidToPhoneMap)) {
    if (!entry.confirmed && (now - (entry.ts || 0)) > TTL_UNCONFIRMED_MS) {
      delete jidToPhoneMap[rawJid];
      removed++;
    }
  }
  if (removed > 0) {
    console.log("[cache] TTL cleanup: " + removed + " unconfirmed entries removed");
    saveCache();
  }
}
setInterval(cleanupCache, 60 * 60 * 1000);

loadCache();

function phoneFromMap(rawJid) {
  const entry = jidToPhoneMap[rawJid];
  if (!entry) return null;
  return typeof entry === "string" ? entry : entry.phone;
}

// confirmed=true: LID ou JID validado diretamente pelo WhatsApp
// confirmed=false: onWhatsApp apenas (sujeito a TTL)
function cacheJidMapping(jid, phone, confirmed = false) {
  const rawJid     = jid.replace(/@.*$/, "");
  const cleanPhone = phone.replace(/\D/g, "");
  if (!rawJid || !cleanPhone) return { migrated: false, previousJid: null };

  const previousJid = phoneToJidMap[cleanPhone] || null;
  const previousRaw = previousJid ? previousJid.replace(/@.*$/, "") : null;

  const wasMigrated =
    previousJid &&
    previousRaw !== rawJid &&
    (
      (previousJid.endsWith("@s.whatsapp.net") && jid.endsWith("@lid")) ||
      (previousJid.endsWith("@lid") && jid.endsWith("@s.whatsapp.net"))
    );

  if (wasMigrated) {
    jidMigrationLog[cleanPhone] = { previous: previousJid, current: jid, migratedAt: new Date().toISOString() };
    stats.lid_migrations++;
    console.log("[jid-migrate] " + cleanPhone + ": " + previousJid + " → " + jid);
  }

  // LIDs são sempre confirmed=true (o WhatsApp não muda LIDs aleatoriamente)
  const finalConfirm = jid.endsWith("@lid") ? true : confirmed;

  jidToPhoneMap[rawJid]     = { phone: cleanPhone, ts: Date.now(), confirmed: finalConfirm };
  phoneToJidMap[cleanPhone] = jid;

  // Mantém alias do rawJid anterior
  if (previousRaw && previousRaw !== rawJid) {
    jidToPhoneMap[previousRaw] = { phone: cleanPhone, ts: Date.now(), confirmed: true };
  }

  // 7. Cache duplo: ao cachear @lid, garante que forma numérica também existe
  if (jid.endsWith("@lid") && /^\d+$/.test(cleanPhone) && !jidToPhoneMap[cleanPhone]) {
    jidToPhoneMap[cleanPhone] = { phone: cleanPhone, ts: Date.now(), confirmed: true };
  }

  saveCache();
  return { migrated: wasMigrated, previousJid };
}

// ═══════════════════════════════════════════════════════════
//  DEDUPLICAÇÃO — persistida em disco (sobrevive restart)
// ═══════════════════════════════════════════════════════════
let processedMsgIds = {};

function loadDedup() {
  try {
    if (fs.existsSync(DEDUP_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DEDUP_FILE, "utf8"));
      const now = Date.now();
      for (const [id, exp] of Object.entries(raw)) {
        if (exp > now) processedMsgIds[id] = exp;
      }
      console.log("[dedup] Loaded " + Object.keys(processedMsgIds).length + " IDs");
    }
  } catch (_) {}
}

let _dedupSavePending = false;
function saveDedup() {
  if (_dedupSavePending) return;
  _dedupSavePending = true;
  setImmediate(() => {
    _dedupSavePending = false;
    try { fs.writeFileSync(DEDUP_FILE, JSON.stringify(processedMsgIds), "utf8"); } catch (_) {}
  });
}

setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [id, exp] of Object.entries(processedMsgIds)) {
    if (exp <= now) { delete processedMsgIds[id]; cleaned++; }
  }
  if (cleaned > 0) saveDedup();
}, 5 * 60 * 1000);

loadDedup();

function isDuplicate(msg) {
  const id = msg.key.id;
  if (!id) return false;
  const now = Date.now();
  if (processedMsgIds[id] && processedMsgIds[id] > now) {
    stats.dedup_dropped++;
    return true;
  }
  processedMsgIds[id] = now + 5 * 60 * 1000;
  saveDedup();
  return false;
}

// ═══════════════════════════════════════════════════════════
//  FILA DE MENSAGENS — persiste antes do webhook (anti-perda)
//  appendFile é async — não bloqueia o event loop
// ═══════════════════════════════════════════════════════════
function enqueuePayload(payload) {
  fs.appendFile(QUEUE_FILE, JSON.stringify(payload) + "\n", () => {});
}

// ═══════════════════════════════════════════════════════════
//  RATE LIMIT — queue independente por sessão (por número)
//  Sessão A e B têm filas separadas → cada uma 850ms entre envios
// ═══════════════════════════════════════════════════════════
const sendQueues  = {};
const sendRunning = {};

function enqueueSend(sessionId, fn) {
  if (!sendQueues[sessionId]) sendQueues[sessionId] = [];
  sendQueues[sessionId].push(fn);
  processSendQueue(sessionId);
}

async function processSendQueue(sessionId) {
  if (sendRunning[sessionId]) return;
  sendRunning[sessionId] = true;
  while (sendQueues[sessionId]?.length > 0) {
    const job = sendQueues[sessionId].shift();
    try { await job(); } catch (e) { console.error("[send-queue]", sessionId, e.message); }
    await sleep(850);   // ~70 msgs/min por número
  }
  sendRunning[sessionId] = false;
}

// ═══════════════════════════════════════════════════════════
//  WEBHOOK — persiste antes de enviar, retry com backoff
// ═══════════════════════════════════════════════════════════
async function sendWebhook(payload, retries = 3) {
  if (!WEBHOOK_URL) return;
  enqueuePayload(payload);
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(WEBHOOK_URL, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
        signal:  AbortSignal.timeout(8000),
      });
      if (res.ok) {
        stats.webhook_ok++;
        stats.queue_flushed++;
        console.log("[webhook] " + payload.event + " ✓ (" + payload.session_id + ")");
        return;
      }
      console.warn("[webhook] HTTP " + res.status + " attempt " + attempt);
    } catch (err) {
      console.error("[webhook] attempt " + attempt + " failed:", err.message);
    }
    if (attempt < retries) await sleep(attempt * 1200);
  }
  stats.webhook_fail++;
  console.error("[webhook] All retries exhausted — persisted in " + QUEUE_FILE);
}

// ═══════════════════════════════════════════════════════════
//  RESOLVE JID — phone → JID para ENVIO
// ═══════════════════════════════════════════════════════════
async function resolveJid(socket, phone) {
  const cleanPhone = phone.replace(/\D/g, "");
  if (phoneToJidMap[cleanPhone]) {
    console.log("[jid] Cache: " + cleanPhone + " → " + phoneToJidMap[cleanPhone]);
    return phoneToJidMap[cleanPhone];
  }
  for (const candidate of buildBRCandidates(cleanPhone)) {
    try {
      const result = await socket.onWhatsApp(candidate);
      if (result?.[0]?.exists) {
        cacheJidMapping(result[0].jid, cleanPhone, false);
        return result[0].jid;
      }
    } catch (_) {}
  }
  return cleanPhone + "@s.whatsapp.net";
}

function buildBRCandidates(p) {
  const c = [p];
  if (p.length === 13 && p.startsWith("55")) c.push(p.slice(0, 4) + p.slice(5));
  else if (p.length === 12 && p.startsWith("55")) c.push(p.slice(0, 4) + "9" + p.slice(4));
  return c;
}

// ═══════════════════════════════════════════════════════════
//  REVERSE RESOLVE — JID/LID → phone
//  onWhatsApp() NÃO resolve @lid. Só o cache resolve.
// ═══════════════════════════════════════════════════════════
async function reverseResolvePhone(socket, jid) {
  const rawJid = jid.replace(/@.*$/, "");
  const isLid  = jid.endsWith("@lid");

  const cached = phoneFromMap(rawJid);
  if (cached) return cached;

  if (!isLid && /^55\d{10,11}$/.test(rawJid)) return rawJid;

  if (!isLid) {
    const candidates = [rawJid, ...(!rawJid.startsWith("55") && rawJid.length >= 10 ? ["55" + rawJid] : [])];
    for (const candidate of candidates) {
      try {
        const result = await socket.onWhatsApp(candidate);
        if (result?.[0]?.exists) {
          const realPhone = result[0].jid.replace(/@.*$/, "");
          cacheJidMapping(jid, realPhone, false);
          return realPhone;
        }
      } catch (_) {}
    }
  }

  if (isLid) return null;
  return rawJid;
}

// 1. RETRY COM BACKOFF CORRETO
// Só consulta cache em loop — onWhatsApp não resolve LID (inútil chamar repetidamente).
// contacts.upsert popula o cache assincronamente; esperamos até 15s por ele.
async function resolveWithRetry(socket, jid, attempts = 5) {
  const rawJid = jid.replace(/@.*$/, "");
  for (let i = 0; i < attempts; i++) {
    const cached = phoneFromMap(rawJid);
    if (cached) { stats.lid_resolved++; return cached; }
    console.log("[retry] LID " + rawJid + " tentativa " + (i + 1) + "/" + attempts);
    await sleep(1000 * (i + 1));   // 1s, 2s, 3s, 4s, 5s → até 15s total
  }
  return reverseResolvePhone(socket, jid);
}

// ═══════════════════════════════════════════════════════════
//  SESSION FACTORY
// ═══════════════════════════════════════════════════════════
async function createSession(sessionId) {
  if (sessions[sessionId]?.socket) return sessions[sessionId];

  const sessionDir = path.join(AUTH_DIR, sessionId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version }          = await fetchLatestBaileysVersion();

  const socket = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    logger,
    printQRInTerminal:              true,
    browser:                        ["Gorilla Spam", "Chrome", "22.0"],
    generateHighQualityLinkPreview: false,
    syncFullHistory:                false,
  });

  const session = { socket, sessionId, qr: null, connected: false, phone: null };
  sessions[sessionId] = session;

  socket.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      session.qr = qr; session.connected = false;
      await sendWebhook({ event: "qr", session_id: sessionId, qr });
    }
    if (connection === "open") {
      session.qr = null; session.connected = true;
      session.phone = socket.user?.id?.split(":")[0] || null;
      console.log("[connected] " + sessionId + " (" + session.phone + ")");
      await sendWebhook({ event: "connected", session_id: sessionId, connected: true, phone_number: session.phone });
    }
    if (connection === "close") {
      session.connected = false;
      const code            = lastDisconnect?.error?.output?.statusCode || 0;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      await sendWebhook({ event: "disconnected", session_id: sessionId, connected: false, reason: shouldReconnect ? "connection_lost" : "logged_out" });
      if (shouldReconnect) {
        delete sessions[sessionId];
        setTimeout(() => createSession(sessionId), 3000);
      } else {
        delete sessions[sessionId];
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
      }
    }
  });

  socket.ev.on("creds.update", saveCreds);

  socket.ev.on("messages.upsert", async ({ type, messages }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (msg.key.fromMe || !msg.message) continue;

      // 3. DEDUPLICAÇÃO
      if (isDuplicate(msg)) { console.log("[dedup] Dropped: " + msg.key.id); continue; }

      const topicJid = msg.key.remoteJid || "";
      if (!topicJid || topicJid === "status@broadcast" || topicJid.endsWith("@g.us")) continue;

      stats.messages_received++;
      const remoteJid = extractRealJid(msg) || topicJid;
      let phone = await reverseResolvePhone(socket, remoteJid);

      if (!phone) {
        stats.lid_unresolved++;
        console.warn("[message] LID não resolvido: " + remoteJid + " — retry com backoff");
        // 1. RETRY COM BACKOFF (substitui setTimeout único de 2s)
        phone = await resolveWithRetry(socket, remoteJid);
        if (!phone) {
          console.error("[message] LID definitivamente não resolvido: " + remoteJid);
          // 4. Persiste na fila para replay manual
          enqueuePayload({ _unresolved: true, jid: remoteJid, session_id: sessionId, text: extractText(msg), ts: Date.now() });
          continue;
        }
      }

      const text = extractText(msg);
      if (!text) continue;
      stats.messages_dispatched++;
      await dispatchMessage(sessionId, phone, remoteJid, text, msg);
    }
  });

  socket.ev.on("contacts.upsert", async (contacts) => {
    for (const contact of contacts) {
      if (!contact.id || !contact.lid) continue;
      const phone   = contact.id.replace(/@.*$/, "");
      const lidFull = contact.lid.endsWith("@lid") ? contact.lid : contact.lid + "@lid";
      if (!/^\d+$/.test(phone)) continue;

      cacheJidMapping(contact.id, phone, true);
      const { migrated, previousJid } = cacheJidMapping(lidFull, phone, true);

      if (migrated) {
        console.log("[contacts.upsert] MIGRAÇÃO: " + phone + " " + previousJid + " → " + lidFull);
        await sendWebhook({ event: "jid_migrated", session_id: sessionId, phone, previous_jid: previousJid, current_jid: lidFull, migrated_at: new Date().toISOString() });
      }
    }
  });

  return session;
}

async function dispatchMessage(sessionId, phone, remoteJid, text, msg) {
  const rawJid    = remoteJid.replace(/@.*$/, "");
  const jidType   = remoteJid.endsWith("@lid") ? "lid" : "phone";
  const migration = jidMigrationLog[phone] || null;
  await sendWebhook({
    event: "message", session_id: sessionId, phone, message: text, from: phone,
    raw_jid: rawJid, jid_type: jidType,
    migration: migration ? { previous_jid: migration.previous, migrated_at: migration.migratedAt } : null,
  });
}

function extractRealJid(msg) {
  // 1. Reply: contextInfo.participant tem o número real (mesmo com LID no remoteJid)
  const replyParticipant =
    msg.message?.extendedTextMessage?.contextInfo?.participant ||
    msg.message?.imageMessage?.contextInfo?.participant ||
    msg.message?.videoMessage?.contextInfo?.participant ||
    msg.message?.documentMessage?.contextInfo?.participant ||
    msg.message?.buttonsResponseMessage?.contextInfo?.participant ||
    msg.message?.listResponseMessage?.contextInfo?.participant ||
    msg.message?.templateButtonReplyMessage?.contextInfo?.participant;

  if (replyParticipant && replyParticipant.endsWith("@s.whatsapp.net")) {
    return replyParticipant;
  }

  // 2. Grupo ou fallback com participant
  if (msg.key.participant && msg.key.participant.endsWith("@s.whatsapp.net")) {
    return msg.key.participant;
  }

  // 3. Padrão
  return msg.key.remoteJid || null;
}


function extractText(msg) {
  const m = msg.message;
  return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || m.documentMessage?.caption || "";
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════

app.get("/", (_, res) => res.json({ status: "ok", version: "v7", sessions: Object.keys(sessions).length, cache_size: Object.keys(jidToPhoneMap).length }));

// 6. MÉTRICAS
app.get("/stats", (_, res) => res.json({
  ...stats,
  uptime_s:         Math.floor(process.uptime()),
  cache_size:       Object.keys(jidToPhoneMap).length,
  dedup_active_ids: Object.keys(processedMsgIds).length,
  send_queues:      Object.fromEntries(Object.entries(sendQueues).map(([sid, q]) => [sid, q.length])),
}));

app.get("/cache", (_, res) => res.json({ jid_to_phone: jidToPhoneMap, phone_to_jid: phoneToJidMap, migrations: jidMigrationLog }));

app.post("/start", async (req, res) => {
  try {
    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ error: "session_id required" });
    const session = await createSession(session_id);
    await sleep(2000);
    res.json({ session_id, qr: session.qr || null, connected: session.connected, phone: session.phone });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/sessions", (_, res) => res.json({
  sessions: Object.values(sessions).map((s) => ({ session_id: s.sessionId, connected: s.connected, has_qr: !!s.qr, phone: s.phone })),
}));

app.delete("/session/:id", async (req, res) => {
  const sessionId = req.params.id;
  const session   = sessions[sessionId];
  if (session?.socket) { try { await session.socket.logout(); } catch (_) { try { session.socket.end(); } catch (_) {} } }
  delete sessions[sessionId];
  const dir = path.join(AUTH_DIR, sessionId);
  try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  res.json({ success: true });
});

// 5. /send com rate limit por sessão
app.post("/send", async (req, res) => {
  try {
    const { session_id, phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: "phone and message required" });
    const sid     = session_id || Object.keys(sessions)[0];
    const session = sessions[sid];
    if (!session?.connected) return res.status(400).json({ error: "Session " + sid + " not connected" });

    const jid = await resolveJid(session.socket, phone);
    res.json({ success: true, session_id: sid, phone, jid, queued: true });

    enqueueSend(sid, async () => {
      const result = await session.socket.sendMessage(jid, { text: message });
      if (result?.key?.remoteJid) {
        const { migrated, previousJid } = cacheJidMapping(result.key.remoteJid, phone, true);
        if (migrated) {
          await sendWebhook({ event: "jid_migrated", session_id: sid, phone: phone.replace(/\D/g, ""), previous_jid: previousJid, current_jid: result.key.remoteJid, migrated_at: new Date().toISOString() });
        }
      }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/send-file", async (req, res) => {
  try {
    const { session_id, phone, file_url, caption = "" } = req.body;
    const file_name = req.body.file_name || "file";
    if (!phone || !file_url) return res.status(400).json({ error: "phone and file_url required" });
    const sid     = session_id || Object.keys(sessions)[0];
    const session = sessions[sid];
    if (!session?.connected) return res.status(400).json({ error: "Session " + sid + " not connected" });

    const jid = await resolveJid(session.socket, phone);
    const ext = file_name.split(".").pop().toLowerCase();
    let msgContent;
    if (["jpg","jpeg","png","gif","webp"].includes(ext))  msgContent = { image: { url: file_url }, caption };
    else if (["mp4","mov","avi","mkv"].includes(ext))      msgContent = { video: { url: file_url }, caption };
    else msgContent = { document: { url: file_url }, fileName: file_name, mimetype: "application/octet-stream", caption };

    res.json({ success: true, session_id: sid, phone, file_name, jid, queued: true });
    enqueueSend(sid, async () => {
      const result = await session.socket.sendMessage(jid, msgContent);
      if (result?.key?.remoteJid) cacheJidMapping(result.key.remoteJid, phone, true);
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/cache-jid", (req, res) => {
  const { jid, phone } = req.body;
  if (!jid || !phone) return res.status(400).json({ error: "jid and phone required" });
  const { migrated, previousJid } = cacheJidMapping(jid, phone, true);
  res.json({ success: true, jid, phone, migrated, previousJid });
});

app.get("/migrations/:phone", (req, res) => {
  const cleanPhone = req.params.phone.replace(/\D/g, "");
  res.json({ phone: cleanPhone, migration: jidMigrationLog[cleanPhone] || null });
});

// ── Graceful shutdown ─────────────────────────────────────
async function shutdown(signal) {
  console.log("[shutdown] " + signal);
  saveCache(); saveDedup();
  for (const s of Object.values(sessions)) { try { s.socket.end(); } catch (_) {} }
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

// ── Start ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log("Gorilla Spam v7 — port " + PORT);
  console.log("Webhook:   " + (WEBHOOK_URL || "NOT SET"));
  console.log("Cache:     " + CACHE_FILE);
  console.log("Queue log: " + QUEUE_FILE);
  if (fs.existsSync(AUTH_DIR)) {
    const dirs = fs.readdirSync(AUTH_DIR).filter((d) => fs.statSync(path.join(AUTH_DIR, d)).isDirectory());
    console.log("Restoring " + dirs.length + " session(s)...");
    dirs.forEach((dir) => createSession(dir).catch((e) => console.error("[restore]", dir, e.message)));
  }
});
