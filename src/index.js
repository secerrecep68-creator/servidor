// ============================================================
// GORILLA SPAM - Baileys Server (v11 - LID Receipt Capture)
//
// FIX 1: Resync de chaves após stream errored out
// FIX 2: Retry de mensagens _unresolved do queue.log
// FIX 3: Alerta de stream errored out via webhook
// FIX 4: Contador de decrypt failures com alerta automático
// FIX 5: Captura LID↔Phone nos receipts (messages.update)
//        — quando o servidor envia msg para @s.whatsapp.net,
//          o WhatsApp retorna receipt com o LID do destinatário
//        — mapeamento 100% seguro, sem correlação temporal
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

const PORT            = process.env.PORT || 3000;
const WEBHOOK_URL     = process.env.WEBHOOK_URL;
const SUPABASE_URL    = process.env.SUPABASE_URL    || "";
const SUPABASE_KEY    = process.env.SUPABASE_ANON_KEY || "";
const AUTH_DIR = fs.existsSync("/data")
  ? path.join("/data", "auth_sessions")
  : path.join(__dirname, "..", "auth_sessions");
const CACHE_DIR       = fs.existsSync("/data") ? "/data" : __dirname;
const CACHE_FILE      = path.join(CACHE_DIR, "jid_cache.json");
const DEDUP_FILE      = path.join(CACHE_DIR, "dedup.json");
const QUEUE_FILE      = path.join(CACHE_DIR, "queue.log");

const logger   = pino({ level: "warn" });
const sessions = {};

// ═══════════════════════════════════════════════════════════
//  MÉTRICAS
// ═══════════════════════════════════════════════════════════
const stats = {
  messages_received:    0,
  messages_dispatched:  0,
  lid_unresolved:       0,
  lid_resolved:         0,
  lid_migrations:       0,
  lid_from_receipts:    0,   // FIX 5
  dedup_dropped:        0,
  webhook_ok:           0,
  webhook_fail:         0,
  queue_flushed:        0,
  supabase_synced:      0,
  supabase_resolved:    0,
  decrypt_failures:     0,
  stream_errors:        0,
  unresolved_retried:   0,
  started_at:           new Date().toISOString(),
};

const decryptFailures = {};

// FIX 5: rastreia mensagens enviadas para correlação segura nos receipts
// Mapeia messageId → { phone, jid, sessionId, ts }
const sentMessageTracker = {};
const SENT_TRACKER_TTL   = 10 * 60 * 1000; // 10 minutos

function trackSentMessage(messageId, phone, jid, sessionId) {
  if (!messageId) return;
  sentMessageTracker[messageId] = { phone, jid, sessionId, ts: Date.now() };
}

// Limpeza periódica do tracker
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of Object.entries(sentMessageTracker)) {
    if (now - entry.ts > SENT_TRACKER_TTL) delete sentMessageTracker[id];
  }
}, 60 * 1000);

// ═══════════════════════════════════════════════════════════
//  CACHE JID — com TTL seletivo
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
      for (const [k, v] of Object.entries(jidToPhoneMap)) {
        if (typeof v === "string") jidToPhoneMap[k] = { phone: v, ts: Date.now(), confirmed: false };
      }
      console.log("[cache] Loaded " + Object.keys(jidToPhoneMap).length + " JID mappings");
    }
  } catch (e) { console.error("[cache] Load failed:", e.message); }
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

function cleanupCache() {
  const now = Date.now(); let removed = 0;
  for (const [rawJid, entry] of Object.entries(jidToPhoneMap)) {
    if (!entry.confirmed && (now - (entry.ts || 0)) > TTL_UNCONFIRMED_MS) {
      delete jidToPhoneMap[rawJid]; removed++;
    }
  }
  if (removed > 0) { console.log("[cache] TTL: removed " + removed); saveCache(); }
}
setInterval(cleanupCache, 60 * 60 * 1000);

loadCache();

function phoneFromMap(rawJid) {
  const e = jidToPhoneMap[rawJid];
  return e ? (typeof e === "string" ? e : e.phone) : null;
}

function cacheJidMapping(jid, phone, confirmed = false) {
  const rawJid     = jid.replace(/@.*$/, "");
  const cleanPhone = phone.replace(/\D/g, "");
  if (!rawJid || !cleanPhone) return { migrated: false, previousJid: null };

  const previousJid = phoneToJidMap[cleanPhone] || null;
  const previousRaw = previousJid ? previousJid.replace(/@.*$/, "") : null;

  const wasMigrated =
    previousJid && previousRaw !== rawJid &&
    (
      (previousJid.endsWith("@s.whatsapp.net") && jid.endsWith("@lid")) ||
      (previousJid.endsWith("@lid") && jid.endsWith("@s.whatsapp.net"))
    );

  if (wasMigrated) {
    jidMigrationLog[cleanPhone] = { previous: previousJid, current: jid, migratedAt: new Date().toISOString() };
    stats.lid_migrations++;
    console.log("[jid-migrate] " + cleanPhone + ": " + previousJid + " → " + jid);
  }

  const finalConfirm            = jid.endsWith("@lid") ? true : confirmed;
  jidToPhoneMap[rawJid]         = { phone: cleanPhone, ts: Date.now(), confirmed: finalConfirm };
  phoneToJidMap[cleanPhone]     = jid;

  if (previousRaw && previousRaw !== rawJid)
    jidToPhoneMap[previousRaw]  = { phone: cleanPhone, ts: Date.now(), confirmed: true };

  if (jid.endsWith("@lid") && /^\d+$/.test(cleanPhone) && !jidToPhoneMap[cleanPhone])
    jidToPhoneMap[cleanPhone]   = { phone: cleanPhone, ts: Date.now(), confirmed: true };

  saveCache();
  return { migrated: wasMigrated, previousJid };
}

// ═══════════════════════════════════════════════════════════
//  SUPABASE SYNC
// ═══════════════════════════════════════════════════════════
function supabaseHeaders() {
  return { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY };
}

async function syncCacheFromSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) { console.log("[sync] Supabase não configurado — skip"); return; }
  try {
    const res = await fetch(
      SUPABASE_URL + "/rest/v1/jid_mappings?select=jid,phone,jid_type&order=updated_at.desc&limit=500",
      { headers: supabaseHeaders(), signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) { console.warn("[sync] Falha: " + res.status); return; }
    const mappings = await res.json();
    let imported = 0;
    for (const m of mappings) {
      if (!m.jid || !m.phone) continue;
      const rawJid = m.jid.replace(/@.*$/, "");
      if (!phoneFromMap(rawJid)) {
        const fullJid = m.jid.includes("@") ? m.jid
          : (m.jid_type === "lid" ? m.jid + "@lid" : m.jid + "@s.whatsapp.net");
        cacheJidMapping(fullJid, m.phone, true);
        imported++;
      }
    }
    stats.supabase_synced += imported;
    console.log("[sync] Importados " + imported + " mapeamentos (total DB: " + mappings.length + ")");
  } catch (e) { console.error("[sync] Erro:", e.message); }
}

async function resolveFromSupabase(rawJid) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const cleanJid = rawJid.replace(/\D/g, "");
    const res = await fetch(
      SUPABASE_URL + "/rest/v1/jid_mappings?select=phone&jid=eq." + cleanJid + "&limit=1",
      { headers: supabaseHeaders(), signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.[0]?.phone) {
      const fullJid = rawJid.includes("@") ? rawJid : rawJid + "@lid";
      cacheJidMapping(fullJid, data[0].phone, true);
      stats.supabase_resolved++;
      console.log("[supabase-resolve] " + rawJid + " → " + data[0].phone);
      return data[0].phone;
    }
  } catch (e) { console.error("[supabase-resolve] Erro:", e.message); }
  return null;
}

async function upsertSupabaseMapping(jid, phone, jidType = "phone") {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    await fetch(SUPABASE_URL + "/rest/v1/jid_mappings", {
      method: "POST",
      headers: {
        ...supabaseHeaders(),
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify({
        jid:        jid.replace(/@.*$/, ""),
        phone:      phone.replace(/\D/g, ""),
        jid_type:   jidType,
        updated_at: new Date().toISOString()
      }),
      signal: AbortSignal.timeout(5000)
    });
    console.log("[supabase-upsert] " + jid + " → " + phone);
  } catch (e) { console.error("[supabase-upsert]", e.message); }
}

// ═══════════════════════════════════════════════════════════
//  FIX 2 — RETRY DE MENSAGENS UNRESOLVED DO QUEUE.LOG
// ═══════════════════════════════════════════════════════════
async function retryUnresolvedQueue(socket, sessionId) {
  if (!fs.existsSync(QUEUE_FILE)) return;
  let lines;
  try { lines = fs.readFileSync(QUEUE_FILE, "utf8").split("\n").filter(Boolean); }
  catch (e) { console.error("[queue-retry] Erro ao ler fila:", e.message); return; }

  if (!lines.length) return;

  const kept = [];

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch (_) { continue; }

    if (!entry._unresolved) { kept.push(line); continue; }

    const jid  = entry.jid;
    const text = entry.text;
    const sid  = entry.session_id || sessionId;

    if (!jid || !text) { kept.push(line); continue; }

    let phone = await resolveWithRetry(socket, jid, 2);
    if (!phone) phone = await resolveFromSupabase(jid.replace(/@.*$/, ""));

    if (phone) {
      stats.unresolved_retried++;
      console.log("[queue-retry] Resolvido: " + jid + " → " + phone);
      await sendWebhook({
        event:        "message",
        session_id:   sid,
        phone:        phone.replace(/\D/g, ""),
        real_phone:   phone.replace(/\D/g, ""),
        message:      text,
        from:         phone.replace(/\D/g, ""),
        raw_jid:      jid.replace(/@.*$/, ""),
        jid_type:     jid.endsWith("@lid") ? "lid" : "phone",
        _retried:     true,
        _original_ts: entry.ts,
      });
    } else {
      kept.push(line);
    }
  }

  try {
    fs.writeFileSync(QUEUE_FILE, kept.join("\n") + (kept.length ? "\n" : ""), "utf8");
    console.log("[queue-retry] Fila: " + kept.filter(l => { try { return JSON.parse(l)._unresolved; } catch(_){return false;} }).length + " pendente(s)");
  } catch (e) { console.error("[queue-retry] Erro ao salvar fila:", e.message); }
}

// ═══════════════════════════════════════════════════════════
//  DEDUPLICAÇÃO — persistida em disco
// ═══════════════════════════════════════════════════════════
let processedMsgIds = {};

function loadDedup() {
  try {
    if (fs.existsSync(DEDUP_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DEDUP_FILE, "utf8"));
      const now = Date.now();
      for (const [id, exp] of Object.entries(raw)) { if (exp > now) processedMsgIds[id] = exp; }
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
  const now = Date.now(); let c = 0;
  for (const [id, exp] of Object.entries(processedMsgIds)) { if (exp <= now) { delete processedMsgIds[id]; c++; } }
  if (c > 0) saveDedup();
}, 5 * 60 * 1000);

loadDedup();

function isDuplicate(msg) {
  const id = msg.key.id;
  if (!id) return false;
  const now = Date.now();
  if (processedMsgIds[id] && processedMsgIds[id] > now) { stats.dedup_dropped++; return true; }
  processedMsgIds[id] = now + 5 * 60 * 1000;
  saveDedup();
  return false;
}

// ═══════════════════════════════════════════════════════════
//  FILA / WAL
// ═══════════════════════════════════════════════════════════
function enqueuePayload(payload) {
  fs.appendFile(QUEUE_FILE, JSON.stringify(payload) + "\n", () => {});
}

// ═══════════════════════════════════════════════════════════
//  RATE LIMIT — queue independente por sessão
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
    const delay = 800 + Math.random() * 400;
    await sleep(delay);
  }
  sendRunning[sessionId] = false;
}

// ═══════════════════════════════════════════════════════════
//  WEBHOOK
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
      if (res.ok) { stats.webhook_ok++; stats.queue_flushed++; console.log("[webhook] " + payload.event + " ✓"); return; }
      console.warn("[webhook] HTTP " + res.status + " attempt " + attempt);
    } catch (err) { console.error("[webhook] attempt " + attempt + ":", err.message); }
    if (attempt < retries) await sleep(attempt * 1200);
  }
  stats.webhook_fail++;
  console.error("[webhook] Exhausted — persisted in " + QUEUE_FILE);
}

// ═══════════════════════════════════════════════════════════
//  RESOLVE JID
// ═══════════════════════════════════════════════════════════
function validatePhone(phone) {
  const clean = phone.replace(/\D/g, "");
  if (!/^\d{10,13}$/.test(clean)) throw new Error("Número inválido: " + phone);
  return clean;
}

async function resolveJid(socket, phone) {
  const cleanPhone = validatePhone(phone);
  if (phoneToJidMap[cleanPhone]) return phoneToJidMap[cleanPhone];
  for (const candidate of buildBRCandidates(cleanPhone)) {
    try {
      const result = await socket.onWhatsApp(candidate);
      if (result?.[0]?.exists) {
        const jid = result[0].jid;
        cacheJidMapping(jid, cleanPhone, false);
        await upsertSupabaseMapping(jid, cleanPhone, "phone");

        const lid = result[0].lid;
        if (lid) {
          const lidFull = lid.endsWith("@lid") ? lid : lid + "@lid";
          cacheJidMapping(lidFull, cleanPhone, true);
          await upsertSupabaseMapping(lidFull, cleanPhone, "lid");
          console.log("[resolve-lid] " + cleanPhone + " → " + lidFull);
        }

        return jid;
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
//  REVERSE RESOLVE
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

async function resolveWithRetry(socket, jid, attempts = 5) {
  const rawJid = jid.replace(/@.*$/, "");

  for (let i = 0; i < attempts; i++) {
    const cached = phoneFromMap(rawJid);
    if (cached) { stats.lid_resolved++; return cached; }

    console.log("[retry] LID " + rawJid + " tentativa " + (i + 1) + "/" + attempts);

    const supabasePhone = await resolveFromSupabase(rawJid);
    if (supabasePhone) { stats.lid_resolved++; return supabasePhone; }

    const socketPhone = await reverseResolvePhone(socket, jid);
    if (socketPhone) {
      cacheJidMapping(jid, socketPhone, true);
      await upsertSupabaseMapping(jid, socketPhone, "lid");
      stats.lid_resolved++;
      return socketPhone;
    }

    await sleep(1000 * (i + 1));
  }

  return null;
}

// ═══════════════════════════════════════════════════════════
//  MESSAGE PARSING
// ═══════════════════════════════════════════════════════════
function unwrapMessage(msgNode) {
  if (!msgNode || typeof msgNode !== "object") return msgNode;
  const inner =
    msgNode.ephemeralMessage?.message ||
    msgNode.viewOnceMessage?.message ||
    msgNode.viewOnceMessageV2?.message ||
    msgNode.viewOnceMessageV2Extension?.message ||
    msgNode.documentWithCaptionMessage?.message ||
    msgNode.editedMessage?.message ||
    msgNode.protocolMessage?.editedMessage;
  return inner ? unwrapMessage(inner) : msgNode;
}

function extractRealJid(msg) {
  const topicJid = msg.key.remoteJid || "";
  if (topicJid.endsWith("@g.us") && msg.key.participant) return msg.key.participant;
  return topicJid || null;
}

function extractText(msg) {
  const m = unwrapMessage(msg.message);
  if (!m) return "";
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.audioMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.listResponseMessage?.title ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    m.templateButtonReplyMessage?.selectedId ||
    m.interactiveResponseMessage?.body?.text ||
    ""
  );
}

// ═══════════════════════════════════════════════════════════
//  SESSION FACTORY
// ═══════════════════════════════════════════════════════════
const reconnectRetries = {};

function getReconnectDelay(sessionId) {
  const retries = reconnectRetries[sessionId] || 0;
  reconnectRetries[sessionId] = retries + 1;
  return Math.min(30000, 3000 * Math.pow(2, retries));
}

async function clearCorruptedSession(sessionId) {
  const sessionDir = path.join(AUTH_DIR, sessionId);
  const keysDir    = path.join(sessionDir, "keys");
  try {
    if (fs.existsSync(keysDir)) {
      fs.rmSync(keysDir, { recursive: true, force: true });
      console.warn("[session-resync] Chaves removidas para " + sessionId + " — próxima reconexão fará resync");
    }
  } catch (e) { console.error("[session-resync] Erro ao limpar chaves:", e.message); }
}

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
      reconnectRetries[sessionId] = 0;
      decryptFailures[sessionId]  = 0;
      console.log("[connected] " + sessionId + " (" + session.phone + ")");
      await sendWebhook({ event: "connected", session_id: sessionId, connected: true, phone_number: session.phone });
      await syncCacheFromSupabase();
      setTimeout(() => retryUnresolvedQueue(socket, sessionId), 3000);
    }

    if (connection === "close") {
      session.connected = false;
      const code            = lastDisconnect?.error?.output?.statusCode || 0;
      const errorMessage    = lastDisconnect?.error?.message || "";
      const shouldReconnect = code !== DisconnectReason.loggedOut;

      await sendWebhook({
        event:         "disconnected",
        session_id:    sessionId,
        connected:     false,
        reason:        shouldReconnect ? "connection_lost" : "logged_out",
        error_code:    code,
        error_message: errorMessage,
      });

      if (shouldReconnect && (decryptFailures[sessionId] || 0) >= 3) {
        console.warn("[session-resync] " + decryptFailures[sessionId] + " decrypt failures — limpando chaves de " + sessionId);
        await clearCorruptedSession(sessionId);
        decryptFailures[sessionId] = 0;
      }

      if (shouldReconnect) {
        delete sessions[sessionId];
        const delay = getReconnectDelay(sessionId);
        console.log("[reconnect] " + sessionId + " em " + (delay / 1000) + "s (retry #" + reconnectRetries[sessionId] + ")");
        setTimeout(() => createSession(sessionId), delay);
      } else {
        delete sessions[sessionId];
        reconnectRetries[sessionId] = 0;
        try { fs.rmSync(path.join(AUTH_DIR, sessionId), { recursive: true, force: true }); } catch (_) {}
      }
    }
  });

  if (socket.ws) {
    socket.ws.on("error", async (err) => {
      stats.stream_errors++;
      console.error("[stream-error] " + sessionId + ":", err?.message || err);
      await sendWebhook({
        event:         "stream_error",
        session_id:    sessionId,
        error_message: err?.message || String(err),
        ts:            Date.now(),
      });
    });
  }

  socket.ev.on("creds.update", saveCreds);

  // ─────────────────────────────────────────────────────────
  // FIX 5: Captura LID nos receipts (messages.update)
  // Quando enviamos uma mensagem para phone@s.whatsapp.net,
  // o WhatsApp responde com um update contendo o remoteJid
  // como LID@lid. Cruzamos com o sentMessageTracker para
  // obter o mapeamento LID↔Phone de forma 100% segura.
  // ─────────────────────────────────────────────────────────
  socket.ev.on("messages.update", async (updates) => {
    for (const update of updates) {
      if (!update.key) continue;

      const messageId = update.key.id;
      const remoteJid = update.key.remoteJid || "";

      // Só nos interessa receipts de mensagens que NÓS enviamos (fromMe)
      if (!update.key.fromMe) continue;

      // Se o remoteJid é um LID, temos oportunidade de mapear
      if (remoteJid.endsWith("@lid")) {
        const rawLid = remoteJid.replace(/@.*$/, "");

        // Já temos esse LID mapeado? Skip.
        if (phoneFromMap(rawLid)) continue;

        // Busca no tracker de mensagens enviadas
        const tracked = sentMessageTracker[messageId];
        if (tracked && tracked.phone) {
          const cleanPhone = tracked.phone.replace(/\D/g, "");
          console.log("[receipt-lid] " + rawLid + " → " + cleanPhone + " (via message " + messageId + ")");

          cacheJidMapping(remoteJid, cleanPhone, true);
          await upsertSupabaseMapping(remoteJid, cleanPhone, "lid");
          stats.lid_from_receipts++;

          // Tenta resolver mensagens pendentes na fila agora que temos o mapeamento
          setTimeout(() => retryUnresolvedQueue(socket, sessionId), 1000);
        }
      }
    }
  });

  socket.ev.on("messages.upsert", async ({ type, messages }) => {
    console.log("[DEBUG] upsert type:", type, "msgs:", messages.length);
    if (type !== "notify") return;
    for (const msg of messages) {
      if (msg.key.fromMe || !msg.message) continue;

      if (msg.messageStubType && !extractText(msg)) {
        decryptFailures[sessionId] = (decryptFailures[sessionId] || 0) + 1;
        stats.decrypt_failures++;
        console.warn("[decrypt-fail] " + sessionId + " — stub: " + msg.messageStubType + " total: " + decryptFailures[sessionId]);
        if (decryptFailures[sessionId] >= 3) {
          await sendWebhook({
            event:      "decrypt_failure_alert",
            session_id: sessionId,
            count:      decryptFailures[sessionId],
            message:    "Múltiplas falhas de descriptografia — sessão pode precisar de resync",
          });
        }
        continue;
      }

      if (isDuplicate(msg)) { console.log("[dedup] Dropped: " + msg.key.id); continue; }

      const topicJid = msg.key.remoteJid || "";
      if (!topicJid || topicJid === "status@broadcast" || topicJid.endsWith("@g.us")) continue;

      stats.messages_received++;

      const remoteJid = extractRealJid(msg) || topicJid;
      let phone = await reverseResolvePhone(socket, remoteJid);

      if (!phone) {
        stats.lid_unresolved++;
        console.warn("[message] JID não resolvido: " + remoteJid + " — retry com backoff + supabase");
        phone = await resolveWithRetry(socket, remoteJid);
        if (!phone) {
          console.error("[message] JID definitivamente não resolvido: " + remoteJid);
          enqueuePayload({ _unresolved: true, jid: remoteJid, session_id: sessionId, text: extractText(msg), ts: Date.now() });
          continue;
        }
      }

      decryptFailures[sessionId] = 0;

      const origRemoteJid = msg.key.remoteJid || "";
      if (origRemoteJid.endsWith("@lid")) {
        const cleanPhone = phone.replace(/\D/g, "");
        cacheJidMapping(origRemoteJid, cleanPhone, true);
        await upsertSupabaseMapping(origRemoteJid, cleanPhone, "lid");
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
      await upsertSupabaseMapping(contact.id, phone, "phone");

      const { migrated, previousJid } = cacheJidMapping(lidFull, phone, true);
      await upsertSupabaseMapping(lidFull, phone, "lid");

      if (migrated) {
        console.log("[contacts.upsert] MIGRAÇÃO: " + phone + " " + previousJid + " → " + lidFull);
        await sendWebhook({ event: "jid_migrated", session_id: sessionId, phone, previous_jid: previousJid, current_jid: lidFull, migrated_at: new Date().toISOString() });
      }
    }
  });

  return session;
}

async function dispatchMessage(sessionId, phone, remoteJid, text, msg) {
  const rawJid     = remoteJid.replace(/@.*$/, "");
  const jidType    = remoteJid.endsWith("@lid") ? "lid" : "phone";
  const cleanPhone = phone.replace(/\D/g, "");
  const migration  = jidMigrationLog[cleanPhone] || null;

  await sendWebhook({
    event:      "message",
    session_id: sessionId,
    phone:      cleanPhone,
    real_phone: cleanPhone,
    message:    text,
    from:       cleanPhone,
    message_id: msg.key.id,
    raw_jid:    rawJid,
    jid_type:   jidType,
    key: {
      remoteJid:   msg.key.remoteJid,
      participant: msg.key.participant || null,
    },
    migration: migration ? { previous_jid: migration.previous, migrated_at: migration.migratedAt } : null,
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════

app.get("/", (_, res) => res.json({ status: "ok", version: "v11", sessions: Object.keys(sessions).length, cache_size: Object.keys(jidToPhoneMap).length }));

app.get("/health", (_, res) => {
  const connected = Object.values(sessions).filter((s) => s.connected);
  const ok        = connected.length > 0;
  res.status(ok ? 200 : 503).json({
    status:             ok ? "healthy" : "degraded",
    connected_sessions: connected.length,
    total_sessions:     Object.keys(sessions).length,
  });
});

app.get("/stats", (_, res) => res.json({
  ...stats,
  uptime_s:            Math.floor(process.uptime()),
  cache_size:          Object.keys(jidToPhoneMap).length,
  dedup_active_ids:    Object.keys(processedMsgIds).length,
  sent_tracker_size:   Object.keys(sentMessageTracker).length,
  decrypt_failures:    { ...decryptFailures },
  send_queues:         Object.fromEntries(Object.entries(sendQueues).map(([sid, q]) => [sid, q.length])),
  reconnect_retries:   { ...reconnectRetries },
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
  reconnectRetries[sessionId] = 0;
  const dir = path.join(AUTH_DIR, sessionId);
  try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  res.json({ success: true });
});

app.post("/send", async (req, res) => {
  try {
    const { session_id, phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: "phone and message required" });

    let cleanPhone;
    try { cleanPhone = validatePhone(phone); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    const sid     = session_id || Object.keys(sessions)[0];
    const session = sessions[sid];
    if (!session?.connected) return res.status(400).json({ error: "Session " + sid + " not connected" });

    const jid = await resolveJid(session.socket, cleanPhone);
    res.json({ success: true, session_id: sid, phone: cleanPhone, jid, queued: true });

    enqueueSend(sid, async () => {
      const result = await session.socket.sendMessage(jid, { text: message });
      if (result?.key) {
        // FIX 5: rastreia a mensagem enviada para capturar LID no receipt
        trackSentMessage(result.key.id, cleanPhone, jid, sid);

        if (result.key.remoteJid) {
          const jidType = result.key.remoteJid.endsWith("@lid") ? "lid" : "phone";
          const { migrated, previousJid } = cacheJidMapping(result.key.remoteJid, cleanPhone, true);
          await upsertSupabaseMapping(result.key.remoteJid, cleanPhone, jidType);
          if (migrated) {
            await sendWebhook({ event: "jid_migrated", session_id: sid, phone: cleanPhone, previous_jid: previousJid, current_jid: result.key.remoteJid, migrated_at: new Date().toISOString() });
          }
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

    let cleanPhone;
    try { cleanPhone = validatePhone(phone); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    const sid     = session_id || Object.keys(sessions)[0];
    const session = sessions[sid];
    if (!session?.connected) return res.status(400).json({ error: "Session " + sid + " not connected" });

    const jid = await resolveJid(session.socket, cleanPhone);
    const ext = file_name.split(".").pop().toLowerCase();
    let msgContent;
    if (["jpg","jpeg","png","gif","webp"].includes(ext))  msgContent = { image: { url: file_url }, caption };
    else if (["mp4","mov","avi","mkv"].includes(ext))      msgContent = { video: { url: file_url }, caption };
    else msgContent = { document: { url: file_url }, fileName: file_name, mimetype: req.body.mimetype || "application/octet-stream", caption };

    res.json({ success: true, session_id: sid, phone: cleanPhone, file_name, jid, queued: true });
    enqueueSend(sid, async () => {
      const result = await session.socket.sendMessage(jid, msgContent);
      if (result?.key) {
        // FIX 5: rastreia para captura de LID no receipt
        trackSentMessage(result.key.id, cleanPhone, jid, sid);

        if (result.key.remoteJid) {
          const jidType = result.key.remoteJid.endsWith("@lid") ? "lid" : "phone";
          cacheJidMapping(result.key.remoteJid, cleanPhone, true);
          await upsertSupabaseMapping(result.key.remoteJid, cleanPhone, jidType);
        }
      }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/cache-jid", async (req, res) => {
  const { jid, phone } = req.body;
  if (!jid || !phone) return res.status(400).json({ error: "jid and phone required" });
  const { migrated, previousJid } = cacheJidMapping(jid, phone, true);
  const jidType = jid.endsWith("@lid") ? "lid" : "phone";
  await upsertSupabaseMapping(jid, phone, jidType);
  res.json({ success: true, jid, phone, migrated, previousJid });
});

app.get("/migrations/:phone", (req, res) => {
  const cleanPhone = req.params.phone.replace(/\D/g, "");
  res.json({ phone: cleanPhone, migration: jidMigrationLog[cleanPhone] || null });
});

app.post("/retry-queue", async (req, res) => {
  const sid     = req.body.session_id || Object.keys(sessions)[0];
  const session = sessions[sid];
  if (!session?.connected) return res.status(400).json({ error: "Sessão não conectada" });
  retryUnresolvedQueue(session.socket, sid);
  res.json({ success: true, message: "Retry iniciado em background" });
});

app.post("/resync-session/:id", async (req, res) => {
  const sessionId = req.params.id;
  await clearCorruptedSession(sessionId);
  const session = sessions[sessionId];
  if (session?.socket) {
    try { session.socket.end(); } catch (_) {}
    delete sessions[sessionId];
  }
  setTimeout(() => createSession(sessionId).catch(console.error), 1000);
  res.json({ success: true, message: "Resync iniciado para " + sessionId });
});

app.post('/onWhatsApp', async (req, res) => {
  try {
    const { session_id, phone } = req.body;
    if (!phone) {
      return res.status(400).json({ error: 'phone is required' });
    }

    const session = sessions.get(session_id);
    if (!session || !session.sock) {
      return res.status(404).json({ error: `Session ${session_id} not found or not connected` });
    }

    const cleanPhone = phone.replace(/[^0-9]/g, '');
    const jid = cleanPhone.includes('@') ? cleanPhone : `${cleanPhone}@s.whatsapp.net`;

    const [result] = await session.sock.onWhatsApp(jid);

    if (result && result.exists) {
      return res.json({ exists: true, jid: result.jid, phone: cleanPhone });
    } else {
      return res.json({ exists: false, jid: null, phone: cleanPhone, error: 'Number not on WhatsApp' });
    }
  } catch (err) {
    console.error('[onWhatsApp] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
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
  console.log("Gorilla Spam v11 — port " + PORT);
  console.log("Webhook:   " + (WEBHOOK_URL    || "NOT SET"));
  console.log("Supabase:  " + (SUPABASE_URL   ? "SET" : "NOT SET"));
  console.log("Cache:     " + CACHE_FILE);
  console.log("Queue log: " + QUEUE_FILE);
  if (fs.existsSync(AUTH_DIR)) {
    const dirs = fs.readdirSync(AUTH_DIR).filter((d) => fs.statSync(path.join(AUTH_DIR, d)).isDirectory());
    console.log("Restoring " + dirs.length + " session(s)...");
    dirs.forEach((dir) => createSession(dir).catch((e) => console.error("[restore]", dir, e.message)));
  }
});
