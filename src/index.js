// ============================================================
// GORILLA SPAM - Baileys Server (v9 - MERGE CORRETO)
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
const AUTH_DIR        = path.join(__dirname, "..", "auth_sessions");
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
  messages_received:   0,
  messages_dispatched: 0,
  lid_unresolved:      0,
  lid_resolved:        0,
  lid_migrations:      0,
  dedup_dropped:       0,
  webhook_ok:          0,
  webhook_fail:        0,
  queue_flushed:       0,
  supabase_synced:     0,
  supabase_resolved:   0,
  started_at:          new Date().toISOString(),
};

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

  // Cache duplo: ao cachear @lid, garante que forma numérica pura também existe
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
//  Delay variável: anti-ban real (12. delay variável)
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
    // 12. Delay variável: simula comportamento humano, dificulta detecção
    const delay = 800 + Math.random() * 400;   // 800–1200ms
    await sleep(delay);
  }
  sendRunning[sessionId] = false;
}

// ═══════════════════════════════════════════════════════════
//  WEBHOOK — WAL antes de enviar, retry com backoff
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
//  RESOLVE JID — phone → JID para ENVIO
//  11. Validação de número antes de resolver
// ═══════════════════════════════════════════════════════════
function validatePhone(phone) {
  const clean = phone.replace(/\D/g, "");
  // Aceita: com DDI 55 (12-13 dígitos) ou sem (10-11 dígitos)
  if (!/^\d{10,13}$/.test(clean)) throw new Error("Número inválido: " + phone);
  return clean;
}

async function resolveJid(socket, phone) {
  const cleanPhone = validatePhone(phone);
  if (phoneToJidMap[cleanPhone]) return phoneToJidMap[cleanPhone];
  for (const candidate of buildBRCandidates(cleanPhone)) {
    try {
      const result = await socket.onWhatsApp(candidate);
      if (result?.[0]?.exists) { cacheJidMapping(result[0].jid, cleanPhone, false); return result[0].jid; }
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
    await sleep(1000 * (i + 1));   // 1s, 2s, 3s, 4s, 5s → até 15s
  }
  // Fallback: Supabase
  const supabasePhone = await resolveFromSupabase(rawJid);
  if (supabasePhone) { stats.lid_resolved++; return supabasePhone; }
  return reverseResolvePhone(socket, jid);
}

// ═══════════════════════════════════════════════════════════
//  MESSAGE PARSING
// ═══════════════════════════════════════════════════════════

// Desempacota mensagens encapsuladas (ephemeral, viewOnce, etc.)
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

// ─── REGRA FUNDAMENTAL DE EXTRAÇÃO DE JID ────────────────────────────────────
//
//  CORRETO:
//    grupo  → msg.key.participant         (quem falou no grupo)
//    direto → msg.key.remoteJid           (o contato)
//
//  ERRADO (não fazer):
//    contextInfo.participant como prioridade máxima — aponta para o AUTOR
//    DA MENSAGEM CITADA num reply, não para quem está enviando agora.
//    Usar isso faz o reply ser atribuído ao contato errado.
//
//  O v8 inverteu essa lógica e foi a causa do bug de hoje.
// ─────────────────────────────────────────────────────────────────────────────
function extractRealJid(msg) {
  const topicJid = msg.key.remoteJid || "";

  // Grupo: participant é quem enviou; remoteJid é o grupo
  if (topicJid.endsWith("@g.us") && msg.key.participant) {
    return msg.key.participant;
  }

  // Chat direto (inclui replies): remoteJid é sempre o remetente.
  // NÃO usamos contextInfo.participant aqui.
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
//  10. Backoff exponencial POR SESSÃO na reconexão
// ═══════════════════════════════════════════════════════════
const reconnectRetries = {};   // sessionId → contagem de retries

function getReconnectDelay(sessionId) {
  const retries = reconnectRetries[sessionId] || 0;
  reconnectRetries[sessionId] = retries + 1;
  // Backoff: 3s, 6s, 12s, 24s, 30s (cap)
  return Math.min(30000, 3000 * Math.pow(2, retries));
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
      reconnectRetries[sessionId] = 0;   // reset backoff ao conectar com sucesso
      console.log("[connected] " + sessionId + " (" + session.phone + ")");
      await sendWebhook({ event: "connected", session_id: sessionId, connected: true, phone_number: session.phone });
      await syncCacheFromSupabase();
    }
    if (connection === "close") {
      session.connected = false;
      const code            = lastDisconnect?.error?.output?.statusCode || 0;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      await sendWebhook({ event: "disconnected", session_id: sessionId, connected: false, reason: shouldReconnect ? "connection_lost" : "logged_out" });
      if (shouldReconnect) {
        delete sessions[sessionId];
        const delay = getReconnectDelay(sessionId);
        console.log("[reconnect] " + sessionId + " em " + (delay / 1000) + "s (retry #" + reconnectRetries[sessionId] + ")");
        setTimeout(() => createSession(sessionId), delay);
      } else {
        delete sessions[sessionId];
        reconnectRetries[sessionId] = 0;
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
      }
    }
  });

  socket.ev.on("creds.update", saveCreds);

  socket.ev.on("messages.upsert", async ({ type, messages }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (msg.key.fromMe || !msg.message) continue;
      if (isDuplicate(msg)) { console.log("[dedup] Dropped: " + msg.key.id); continue; }

      const topicJid = msg.key.remoteJid || "";
      if (!topicJid || topicJid === "status@broadcast" || topicJid.endsWith("@g.us")) continue;

      stats.messages_received++;

      // EXTRAÇÃO CORRETA: nunca usa contextInfo.participant como remetente
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

      // Auto-cache: se remoteJid original era @lid e agora temos o phone
      const origRemoteJid = msg.key.remoteJid || "";
      if (origRemoteJid.endsWith("@lid")) {
        const cleanPhone = phone.replace(/\D/g, "");
        cacheJidMapping(origRemoteJid, cleanPhone, true);
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

// 9. message_id no payload para idempotência no backend
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
    message_id: msg.key.id,          // 9. idempotência: backend ignora duplicados pelo ID
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

app.get("/", (_, res) => res.json({ status: "ok", version: "v9", sessions: Object.keys(sessions).length, cache_size: Object.keys(jidToPhoneMap).length }));

// 13. /health com HTTP 503 quando sem sessão conectada (Railway healthcheck)
app.get("/health", (_, res) => {
  const connected = Object.values(sessions).filter((s) => s.connected);
  const ok        = connected.length > 0;
  res.status(ok ? 200 : 503).json({
    status:            ok ? "healthy" : "degraded",
    connected_sessions:connected.length,
    total_sessions:    Object.keys(sessions).length,
  });
});

app.get("/stats", (_, res) => res.json({
  ...stats,
  uptime_s:          Math.floor(process.uptime()),
  cache_size:        Object.keys(jidToPhoneMap).length,
  dedup_active_ids:  Object.keys(processedMsgIds).length,
  send_queues:       Object.fromEntries(Object.entries(sendQueues).map(([sid, q]) => [sid, q.length])),
  reconnect_retries: { ...reconnectRetries },
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

// 11. Validação + rate limit por sessão
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
      if (result?.key?.remoteJid) {
        const { migrated, previousJid } = cacheJidMapping(result.key.remoteJid, cleanPhone, true);
        if (migrated) {
          await sendWebhook({ event: "jid_migrated", session_id: sid, phone: cleanPhone, previous_jid: previousJid, current_jid: result.key.remoteJid, migrated_at: new Date().toISOString() });
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
    else msgContent = { document: { url: file_url }, fileName: file_name, mimetype: "application/octet-stream", caption };

    res.json({ success: true, session_id: sid, phone: cleanPhone, file_name, jid, queued: true });
    enqueueSend(sid, async () => {
      const result = await session.socket.sendMessage(jid, msgContent);
      if (result?.key?.remoteJid) cacheJidMapping(result.key.remoteJid, cleanPhone, true);
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
  console.log("Gorilla Spam v9 — port " + PORT);
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
