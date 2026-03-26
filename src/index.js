// ============================================================
// GORILLA SPAM - Baileys Server (v5 - JID EXTRACTION FIX)
// Fixes:
//   1. Cache JID↔Phone persistido em disco (sobrevive restarts)
//   2. onWhatsApp() NÃO resolve LID — removida chamada inútil
//   3. Webhook bloqueado se LID não foi resolvido (evita descarte)
//   4. extractRealJid() extrai o JID do REMETENTE corretamente
//      — grupo: msg.key.participant tem precedência sobre remoteJid
//      — direto/reply: remoteJid é sempre o remetente; contextInfo.participant
//        aponta para quem foi CITADO, não quem enviou — ignorado aqui
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
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const AUTH_DIR = path.join(__dirname, "..", "auth_sessions");

// ═══ Cache persistido em disco ═══
// Monte um Railway Volume em /data para que sobreviva entre deploys.
// Se não houver volume, cai para __dirname (cache temporário mas melhor que nada).
const CACHE_DIR = fs.existsSync("/data") ? "/data" : __dirname;
const CACHE_FILE = path.join(CACHE_DIR, "jid_cache.json");

const logger = pino({ level: "warn" });
const sessions = {};

// ─── Carrega cache do disco ao iniciar ───
let jidToPhoneMap = {};
let phoneToJidMap = {};

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, "utf8");
      const parsed = JSON.parse(raw);
      jidToPhoneMap = parsed.jidToPhone || {};
      phoneToJidMap = parsed.phoneToJid || {};
      console.log("[cache] Loaded " + Object.keys(jidToPhoneMap).length + " JID mappings from disk");
    }
  } catch (e) {
    console.error("[cache] Failed to load cache:", e.message);
  }
}

function saveCache() {
  try {
    fs.writeFileSync(
      CACHE_FILE,
      JSON.stringify({ jidToPhone: jidToPhoneMap, phoneToJid: phoneToJidMap }, null, 2),
      "utf8"
    );
  } catch (e) {
    console.error("[cache] Failed to save cache:", e.message);
  }
}

loadCache();

function cacheJidMapping(jid, phone) {
  const rawJid = jid.replace(/@.*$/, "");
  const cleanPhone = phone.replace(/\D/g, "");
  if (!rawJid || !cleanPhone) return;

  const changed = jidToPhoneMap[rawJid] !== cleanPhone || phoneToJidMap[cleanPhone] !== jid;
  jidToPhoneMap[rawJid] = cleanPhone;
  phoneToJidMap[cleanPhone] = jid;

  if (changed) {
    console.log("[jid-cache] Mapped " + rawJid + " <-> " + cleanPhone);
    saveCache(); // persiste imediatamente em mudanças
  }
}

// --- Webhook Helper ---
async function sendWebhook(payload) {
  if (!WEBHOOK_URL) {
    console.log("[webhook] WEBHOOK_URL not set, skipping:", payload.event);
    return;
  }
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    console.log("[webhook] " + payload.event + " for " + payload.session_id + " -> " + res.status);
  } catch (err) {
    console.error("[webhook] Failed:", err.message);
  }
}

// --- Resolve JID (phone → JID para ENVIO) ---
async function resolveJid(socket, phone) {
  const cleanPhone = phone.replace(/\D/g, "");

  // 1. Cache hit — pode retornar um @lid direto
  if (phoneToJidMap[cleanPhone]) {
    console.log("[jid] Cache hit: " + cleanPhone + " -> " + phoneToJidMap[cleanPhone]);
    return phoneToJidMap[cleanPhone];
  }

  // 2. onWhatsApp resolve número → JID real
  try {
    const result = await socket.onWhatsApp(cleanPhone);
    if (result && result.length > 0 && result[0].exists) {
      console.log("[jid] Resolved " + cleanPhone + " -> " + result[0].jid);
      cacheJidMapping(result[0].jid, cleanPhone);
      return result[0].jid;
    }

    // Ajuste dígito 9 para números brasileiros
    let altPhone = cleanPhone;
    if (cleanPhone.length === 13 && cleanPhone.startsWith("55")) {
      altPhone = cleanPhone.slice(0, 4) + cleanPhone.slice(5);
    } else if (cleanPhone.length === 12 && cleanPhone.startsWith("55")) {
      altPhone = cleanPhone.slice(0, 4) + "9" + cleanPhone.slice(4);
    }

    if (altPhone !== cleanPhone) {
      const result2 = await socket.onWhatsApp(altPhone);
      if (result2 && result2.length > 0 && result2[0].exists) {
        console.log("[jid] Resolved alt " + altPhone + " -> " + result2[0].jid);
        cacheJidMapping(result2[0].jid, cleanPhone);
        return result2[0].jid;
      }
    }
  } catch (e) {
    console.log("[jid] onWhatsApp failed for " + cleanPhone + ": " + e.message);
  }

  console.log("[jid] Fallback to raw: " + cleanPhone);
  return cleanPhone + "@s.whatsapp.net";
}

// ═══ Reverse resolve: JID/LID → phone ═══
// IMPORTANTE: onWhatsApp() NÃO resolve LIDs. Só o cache resolve.
// O cache é populado quando:
//   a) O bot envia mensagem primeiro (/send → sendMessage retorna JID real)
//   b) O contato já enviou antes e foi cacheado
async function reverseResolvePhone(socket, jid) {
  const rawJid = jid.replace(/@.*$/, "");
  const isLid = jid.endsWith("@lid");

  // 1. Cache hit (única forma confiável de resolver LID)
  if (jidToPhoneMap[rawJid]) {
    console.log("[reverse-jid] Cache hit: " + rawJid + " -> " + jidToPhoneMap[rawJid]);
    return jidToPhoneMap[rawJid];
  }

  // 2. Se for @s.whatsapp.net com número BR válido, usa direto
  if (!isLid && /^55\d{10,11}$/.test(rawJid)) {
    return rawJid;
  }

  // 3. Se for @s.whatsapp.net, tenta onWhatsApp (NÃO tenta para @lid)
  if (!isLid) {
    try {
      const result = await socket.onWhatsApp(rawJid);
      if (result && result.length > 0 && result[0].exists) {
        const realPhone = result[0].jid.replace(/@.*$/, "");
        cacheJidMapping(jid, realPhone);
        console.log("[reverse-jid] onWhatsApp: " + rawJid + " -> " + realPhone);
        return realPhone;
      }
    } catch (e) {
      console.log("[reverse-jid] onWhatsApp failed for " + rawJid + ": " + e.message);
    }

    // Tenta adicionar DDI 55
    if (rawJid.length >= 10 && !rawJid.startsWith("55")) {
      const withCountry = "55" + rawJid;
      try {
        const result2 = await socket.onWhatsApp(withCountry);
        if (result2 && result2.length > 0 && result2[0].exists) {
          const realPhone2 = result2[0].jid.replace(/@.*$/, "");
          cacheJidMapping(jid, realPhone2);
          console.log("[reverse-jid] Added 55: " + rawJid + " -> " + realPhone2);
          return realPhone2;
        }
      } catch (e) {}
    }
  }

  // 4. LID não resolvido — retorna null para bloquear webhook
  if (isLid) {
    console.warn("[reverse-jid] UNRESOLVED LID: " + rawJid + " — webhook será suprimido. Cache atual:", JSON.stringify(jidToPhoneMap));
    return null;
  }

  return rawJid;
}

// --- Create/Restore Session ---
async function createSession(sessionId) {
  if (sessions[sessionId] && sessions[sessionId].socket) {
    return sessions[sessionId];
  }

  const sessionDir = path.join(AUTH_DIR, sessionId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  const socket = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    printQRInTerminal: true,
    browser: ["Gorilla Spam", "Chrome", "22.0"],
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
  });

  const session = {
    socket: socket,
    sessionId: sessionId,
    qr: null,
    connected: false,
    phone: null,
  };
  sessions[sessionId] = session;

  socket.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      session.qr = qr;
      session.connected = false;
      console.log("[qr] " + sessionId + ": New QR generated");
      await sendWebhook({ event: "qr", session_id: sessionId, qr: qr });
    }

    if (connection === "open") {
      session.qr = null;
      session.connected = true;
      session.phone = socket.user && socket.user.id ? socket.user.id.split(":")[0] : null;
      console.log("[connected] " + sessionId + ": " + session.phone);
      await sendWebhook({
        event: "connected",
        session_id: sessionId,
        connected: true,
        phone_number: session.phone,
      });
    }

    if (connection === "close") {
      session.connected = false;
      const statusCode = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
        ? lastDisconnect.error.output.statusCode : 0;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log("[disconnected] " + sessionId + ": code=" + statusCode + " reconnect=" + shouldReconnect);
      await sendWebhook({
        event: "disconnected",
        session_id: sessionId,
        connected: false,
        reason: statusCode === DisconnectReason.loggedOut ? "logged_out" : "connection_lost",
      });

      if (shouldReconnect) {
        delete sessions[sessionId];
        setTimeout(function () { createSession(sessionId); }, 3000);
      } else {
        delete sessions[sessionId];
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
      }
    }
  });

  socket.ev.on("creds.update", saveCreds);

  // ═══ Incoming messages ═══
  socket.ev.on("messages.upsert", async (upsert) => {
    if (upsert.type !== "notify") return;

    for (const msg of upsert.messages) {
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      const topicJid = msg.key.remoteJid || "";
      if (!topicJid || topicJid === "status@broadcast") continue;
      // Grupos: filtra aqui (remova esse continue para suportar grupos no futuro)
      if (topicJid.endsWith("@g.us")) continue;

      // JID do remetente real:
      //   grupo  → msg.key.participant (quem falou)
      //   direto → msg.key.remoteJid   (o próprio contato)
      // contextInfo.participant NÃO é usado aqui — identifica o autor da msg CITADA,
      // não de quem está enviando.
      const remoteJid = extractRealJid(msg) || topicJid;

      // ═══ CRÍTICO: resolve phone; se LID não resolvido, suprime webhook ═══
      const phone = await reverseResolvePhone(socket, remoteJid);

      if (!phone) {
        // LID sem mapeamento — enfileira para retry após 2s
        // (pode chegar um contacts.upsert logo depois com o mapeamento)
        console.warn("[message] LID não resolvido para " + remoteJid + ", aguardando contacts.upsert...");
        setTimeout(async () => {
          const retryPhone = await reverseResolvePhone(socket, remoteJid);
          if (!retryPhone) {
            console.error("[message] LID ainda não resolvido após retry: " + remoteJid + " — mensagem perdida");
            return;
          }
          const text = extractText(msg);
          if (!text) return;
          console.log("[message-retry] " + sessionId + " from " + retryPhone + " (jid: " + remoteJid.replace(/@.+/, "") + "): " + text.substring(0, 50));
          await sendWebhook({
            event: "message",
            session_id: sessionId,
            phone: retryPhone,
            message: text,
            from: retryPhone,
            raw_jid: remoteJid.replace(/@.+/, ""),
          });
        }, 2000);
        continue;
      }

      const text = extractText(msg);
      if (!text) continue;

      console.log("[message] " + sessionId + " from " + phone + " (jid: " + remoteJid.replace(/@.+/, "") + "): " + text.substring(0, 50));
      await sendWebhook({
        event: "message",
        session_id: sessionId,
        phone: phone,
        message: text,
        from: phone,
        raw_jid: remoteJid.replace(/@.+/, ""),
      });
    }
  });

  // ═══ contacts.upsert popula o cache proativamente ═══
  // Quando o WhatsApp sincroniza contatos, manda LID↔phone aqui
  socket.ev.on("contacts.upsert", (contacts) => {
    for (const contact of contacts) {
      if (contact.id && contact.notify) {
        // contact.id pode ser @lid; contact.lid ou contact.phone pode ter o número
      }
      if (contact.id && contact.lid) {
        // id = @s.whatsapp.net, lid = @lid
        const phone = contact.id.replace(/@.*$/, "");
        const lidJid = contact.lid.endsWith("@lid") ? contact.lid : contact.lid + "@lid";
        if (/^\d+$/.test(phone)) {
          cacheJidMapping(lidJid, phone);
          console.log("[contacts.upsert] LID mapeado: " + contact.lid + " -> " + phone);
        }
      }
    }
  });

  return session;
}

// ═══ Extrai o JID do REMETENTE real da mensagem ═══
//
// Regra:
//   - Grupos  → msg.key.participant  (quem falou dentro do grupo)
//   - Direto  → msg.key.remoteJid   (o próprio contato)
//
// NÃO usamos contextInfo.participant aqui porque ele identifica o autor
// da mensagem CITADA num reply, não quem está enviando a mensagem atual.
// Usar esse campo como remetente causaria atribuição incorreta.
function extractRealJid(msg) {
  const isGroup = msg.key.remoteJid && msg.key.remoteJid.endsWith("@g.us");

  // Grupo: participante é quem enviou; remoteJid é o grupo
  if (isGroup && msg.key.participant) {
    return msg.key.participant;
  }

  // Direto (inclui replies): remoteJid é sempre o remetente
  return msg.key.remoteJid || null;
}

function extractText(msg) {
  return (
    msg.message.conversation ||
    (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) ||
    (msg.message.imageMessage && msg.message.imageMessage.caption) ||
    (msg.message.videoMessage && msg.message.videoMessage.caption) ||
    (msg.message.documentMessage && msg.message.documentMessage.caption) ||
    ""
  );
}

// --- Routes ---

app.get("/", function (req, res) {
  res.json({
    status: "ok",
    sessions: Object.keys(sessions).length,
    jid_cache_size: Object.keys(jidToPhoneMap).length,
    jid_cache: jidToPhoneMap,
    cache_file: CACHE_FILE,
  });
});

app.post("/start", async function (req, res) {
  try {
    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ error: "session_id required" });
    const session = await createSession(session_id);
    await new Promise((r) => setTimeout(r, 2000));
    res.json({ session_id, qr: session.qr || null, connected: session.connected, phone: session.phone });
  } catch (err) {
    console.error("[start]", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/sessions", function (req, res) {
  res.json({
    sessions: Object.values(sessions).map((s) => ({
      session_id: s.sessionId,
      connected: s.connected,
      has_qr: !!s.qr,
      phone: s.phone,
    })),
  });
});

app.delete("/session/:id", async function (req, res) {
  const sessionId = req.params.id;
  const session = sessions[sessionId];
  if (session && session.socket) {
    try { await session.socket.logout(); } catch (e) {
      try { session.socket.end(); } catch (e2) {}
    }
  }
  delete sessions[sessionId];
  const sessionDir = path.join(AUTH_DIR, sessionId);
  try { if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
  res.json({ success: true });
});

// ═══ /send — cacheia JID retornado pelo sendMessage ═══
app.post("/send", async function (req, res) {
  try {
    const { session_id, phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: "phone and message required" });
    const sid = session_id || Object.keys(sessions)[0];
    const session = sessions[sid];
    if (!session || !session.connected) return res.status(400).json({ error: "Session " + sid + " not connected" });

    const jid = await resolveJid(session.socket, phone);
    const result = await session.socket.sendMessage(jid, { text: message });

    if (result && result.key && result.key.remoteJid) {
      const cleanPhone = phone.replace(/\D/g, "");
      console.log("[send] sendMessage returned jid: " + result.key.remoteJid + " for phone: " + cleanPhone);
      cacheJidMapping(result.key.remoteJid, cleanPhone);
    }

    res.json({ success: true, session_id: sid, phone, jid });
  } catch (err) {
    console.error("[send]", err);
    res.status(500).json({ error: err.message });
  }
});

// ═══ /send-file — cacheia JID retornado pelo sendMessage ═══
app.post("/send-file", async function (req, res) {
  try {
    const { session_id, phone, file_url, caption = "" } = req.body;
    const file_name = req.body.file_name || "file";
    if (!phone || !file_url) return res.status(400).json({ error: "phone and file_url required" });
    const sid = session_id || Object.keys(sessions)[0];
    const session = sessions[sid];
    if (!session || !session.connected) return res.status(400).json({ error: "Session " + sid + " not connected" });

    const jid = await resolveJid(session.socket, phone);
    const ext = file_name.split(".").pop().toLowerCase();
    let msgContent;
    if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) {
      msgContent = { image: { url: file_url }, caption };
    } else if (["mp4", "mov", "avi", "mkv"].includes(ext)) {
      msgContent = { video: { url: file_url }, caption };
    } else {
      msgContent = { document: { url: file_url }, fileName: file_name, mimetype: "application/octet-stream", caption };
    }

    const result = await session.socket.sendMessage(jid, msgContent);

    if (result && result.key && result.key.remoteJid) {
      const cleanPhone = phone.replace(/\D/g, "");
      console.log("[send-file] sendMessage returned jid: " + result.key.remoteJid + " for phone: " + cleanPhone);
      cacheJidMapping(result.key.remoteJid, cleanPhone);
    }

    res.json({ success: true, session_id: sid, phone, file_name, jid });
  } catch (err) {
    console.error("[send-file]", err);
    res.status(500).json({ error: err.message });
  }
});

// ═══ /cache-jid — permite injetar mapeamento manualmente (emergência) ═══
app.post("/cache-jid", function (req, res) {
  const { jid, phone } = req.body;
  if (!jid || !phone) return res.status(400).json({ error: "jid and phone required" });
  cacheJidMapping(jid, phone);
  res.json({ success: true, jid, phone });
});

// --- Start ---
app.listen(PORT, function () {
  console.log("Gorilla Spam Baileys Server v4 on port " + PORT);
  console.log("Webhook URL: " + (WEBHOOK_URL || "NOT SET"));
  console.log("Cache file: " + CACHE_FILE);
  if (fs.existsSync(AUTH_DIR)) {
    const dirs = fs.readdirSync(AUTH_DIR).filter((d) =>
      fs.statSync(path.join(AUTH_DIR, d)).isDirectory()
    );
    console.log("Restoring " + dirs.length + " sessions...");
    dirs.forEach((dir) => {
      createSession(dir).catch((err) => {
        console.error("[restore] Failed " + dir + ":", err.message);
      });
    });
  }
});
