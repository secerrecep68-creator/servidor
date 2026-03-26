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

const logger = pino({ level: "warn" });
const sessions = {};

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
    const text = await res.text();
    console.log("[webhook] " + payload.event + " for " + payload.session_id + " -> " + res.status);
  } catch (err) {
    console.error("[webhook] Failed:", err.message);
  }
}

// --- Resolve JID (fix Brazilian 9th digit issue) ---
async function resolveJid(socket, phone) {
  var cleanPhone = phone.replace(/\D/g, "");

  try {
    // Try the number as-is first
    var result = await socket.onWhatsApp(cleanPhone);
    if (result && result.length > 0 && result[0].exists) {
      console.log("[jid] Resolved " + cleanPhone + " -> " + result[0].jid);
      return result[0].jid;
    }

    // Try alternate format (with/without 9th digit for Brazilian numbers)
    var altPhone = cleanPhone;
    if (cleanPhone.length === 13 && cleanPhone.startsWith("55")) {
      // Remove the 9th digit: 55 + DD + 9XXXXXXXX -> 55 + DD + XXXXXXXX
      altPhone = cleanPhone.slice(0, 4) + cleanPhone.slice(5);
    } else if (cleanPhone.length === 12 && cleanPhone.startsWith("55")) {
      // Add the 9th digit: 55 + DD + XXXXXXXX -> 55 + DD + 9XXXXXXXX
      altPhone = cleanPhone.slice(0, 4) + "9" + cleanPhone.slice(4);
    }

    if (altPhone !== cleanPhone) {
      var result2 = await socket.onWhatsApp(altPhone);
      if (result2 && result2.length > 0 && result2[0].exists) {
        console.log("[jid] Resolved alt " + altPhone + " -> " + result2[0].jid);
        return result2[0].jid;
      }
    }

    // Fallback to raw number
    console.log("[jid] No WhatsApp match, using raw: " + cleanPhone);
    return cleanPhone + "@s.whatsapp.net";
  } catch (e) {
    console.log("[jid] onWhatsApp failed, using raw: " + cleanPhone + " (" + e.message + ")");
    return cleanPhone + "@s.whatsapp.net";
  }
}

// --- Reverse resolve: get real phone number from JID ---
async function reverseResolvePhone(socket, jid) {
  var rawPhone = jid.replace(/@.*$/, "");

  try {
    // Use onWhatsApp to check if this JID maps to a known number
    var result = await socket.onWhatsApp(rawPhone);
    if (result && result.length > 0 && result[0].exists) {
      // Extract the real phone from the verified JID
      var realPhone = result[0].jid.replace(/@.*$/, "");
      if (realPhone !== rawPhone) {
        console.log("[reverse-jid] " + rawPhone + " -> " + realPhone);
      }
      return realPhone;
    }
  } catch (e) {
    console.log("[reverse-jid] lookup failed for " + rawPhone + ": " + e.message);
  }

  // For Brazilian numbers, try adding country code or 9th digit
  if (rawPhone.length >= 10 && !rawPhone.startsWith("55")) {
    var withCountry = "55" + rawPhone;
    try {
      var result2 = await socket.onWhatsApp(withCountry);
      if (result2 && result2.length > 0 && result2[0].exists) {
        var realPhone2 = result2[0].jid.replace(/@.*$/, "");
        console.log("[reverse-jid] Added 55: " + rawPhone + " -> " + realPhone2);
        return realPhone2;
      }
    } catch (e) {}
  }

  return rawPhone;
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

  // Connection updates
  socket.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      session.qr = qr;
      session.connected = false;
      console.log("[qr] " + sessionId + ": New QR generated");
      await sendWebhook({
        event: "qr",
        session_id: sessionId,
        qr: qr,
      });
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
      var statusCode = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
        ? lastDisconnect.error.output.statusCode : 0;
      var shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log("[disconnected] " + sessionId + ": code=" + statusCode + " reconnect=" + shouldReconnect);
      await sendWebhook({
        event: "disconnected",
        session_id: sessionId,
        connected: false,
        reason: statusCode === DisconnectReason.loggedOut ? "logged_out" : "connection_lost",
      });

      if (shouldReconnect) {
        delete sessions[sessionId];
        setTimeout(function() { createSession(sessionId); }, 3000);
      } else {
        delete sessions[sessionId];
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
      }
    }
  });

  socket.ev.on("creds.update", saveCreds);

  // Incoming messages
  socket.ev.on("messages.upsert", async (upsert) => {
    if (upsert.type !== "notify") return;
    var messages = upsert.messages;
    for (var i = 0; i < messages.length; i++) {
      var msg = messages[i];
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      var remoteJid = msg.key.remoteJid || "";
      if (!remoteJid || remoteJid === "status@broadcast" || remoteJid.endsWith("@g.us")) continue;

      // FIX: Resolve the real phone number from the JID
      var phone = await reverseResolvePhone(socket, remoteJid);

      var text = (msg.message.conversation ||
        (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) ||
        (msg.message.imageMessage && msg.message.imageMessage.caption) ||
        (msg.message.videoMessage && msg.message.videoMessage.caption) ||
        (msg.message.documentMessage && msg.message.documentMessage.caption) || "");
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

  return session;
}

// --- Routes ---

app.get("/", function(req, res) {
  res.json({ status: "ok", sessions: Object.keys(sessions).length });
});

app.post("/start", async function(req, res) {
  try {
    var session_id = req.body.session_id;
    if (!session_id) return res.status(400).json({ error: "session_id required" });
    var session = await createSession(session_id);
    await new Promise(function(r) { setTimeout(r, 2000); });
    res.json({
      session_id: session_id,
      qr: session.qr || null,
      connected: session.connected,
      phone: session.phone,
    });
  } catch (err) {
    console.error("[start]", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/sessions", function(req, res) {
  var list = Object.values(sessions).map(function(s) {
    return {
      session_id: s.sessionId,
      connected: s.connected,
      has_qr: !!s.qr,
      phone: s.phone,
    };
  });
  res.json({ sessions: list });
});

app.delete("/session/:id", async function(req, res) {
  var sessionId = req.params.id;
  var session = sessions[sessionId];
  if (session && session.socket) {
    try { await session.socket.logout(); } catch (e) {
      try { session.socket.end(); } catch (e2) {}
    }
  }
  delete sessions[sessionId];
  var sessionDir = path.join(AUTH_DIR, sessionId);
  try { if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
  res.json({ success: true });
});

app.post("/send", async function(req, res) {
  try {
    var session_id = req.body.session_id;
    var phone = req.body.phone;
    var message = req.body.message;
    if (!phone || !message) return res.status(400).json({ error: "phone and message required" });
    var sid = session_id || Object.keys(sessions)[0];
    var session = sessions[sid];
    if (!session || !session.connected) return res.status(400).json({ error: "Session " + sid + " not connected" });

    var jid = await resolveJid(session.socket, phone);
    await session.socket.sendMessage(jid, { text: message });
    res.json({ success: true, session_id: sid, phone: phone, jid: jid });
  } catch (err) {
    console.error("[send]", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/send-file", async function(req, res) {
  try {
    var session_id = req.body.session_id;
    var phone = req.body.phone;
    var file_url = req.body.file_url;
    var file_name = req.body.file_name || "file";
    var caption = req.body.caption || "";
    if (!phone || !file_url) return res.status(400).json({ error: "phone and file_url required" });
    var sid = session_id || Object.keys(sessions)[0];
    var session = sessions[sid];
    if (!session || !session.connected) return res.status(400).json({ error: "Session " + sid + " not connected" });

    var jid = await resolveJid(session.socket, phone);
    var ext = file_name.split(".").pop().toLowerCase();
    var imageExts = ["jpg", "jpeg", "png", "gif", "webp"];
    var videoExts = ["mp4", "mov", "avi", "mkv"];
    var msgContent;
    if (imageExts.indexOf(ext) >= 0) {
      msgContent = { image: { url: file_url }, caption: caption };
    } else if (videoExts.indexOf(ext) >= 0) {
      msgContent = { video: { url: file_url }, caption: caption };
    } else {
      msgContent = { document: { url: file_url }, fileName: file_name, mimetype: "application/octet-stream", caption: caption };
    }
    await session.socket.sendMessage(jid, msgContent);
    res.json({ success: true, session_id: sid, phone: phone, file_name: file_name, jid: jid });
  } catch (err) {
    console.error("[send-file]", err);
    res.status(500).json({ error: err.message });
  }
});

// --- Start ---
app.listen(PORT, function() {
  console.log("Gorilla Spam Baileys Server on port " + PORT);
  console.log("Webhook URL: " + (WEBHOOK_URL || "NOT SET"));
  if (fs.existsSync(AUTH_DIR)) {
    var dirs = fs.readdirSync(AUTH_DIR).filter(function(d) {
      return fs.statSync(path.join(AUTH_DIR, d)).isDirectory();
    });
    console.log("Restoring " + dirs.length + " sessions...");
    dirs.forEach(function(dir) {
      createSession(dir).catch(function(err) {
        console.error("[restore] Failed " + dir + ":", err.message);
      });
    });
  }
});
