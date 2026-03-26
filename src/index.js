const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const express = require('express');
const cors = require('cors');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const logger = pino({ level: 'info' });

// Store active sessions
const sessions = {};

// ===== HELPERS =====

function formatPhone(phone) {
  let cleaned = phone.replace(/\D/g, '');
  if (!cleaned.endsWith('@s.whatsapp.net')) {
    cleaned = cleaned + '@s.whatsapp.net';
  }
  return cleaned;
}

// Webhook para notificar o Supabase sobre mudanças de status
async function notifyWebhook(event, data) {
  const webhookUrl = process.env.WEBHOOK_URL;
  if (!webhookUrl) return;
  try {
    await axios.post(webhookUrl, { event, ...data });
  } catch (e) {
    logger.error(`Webhook error: ${e.message}`);
  }
}

// ===== SESSION MANAGEMENT =====

async function startSession(sessionId) {
  if (sessions[sessionId]?.sock) {
    // Session already exists
    const state = sessions[sessionId];
    if (state.qr) {
      return { status: 'awaiting_qr', qr: state.qr };
    }
    if (state.connected) {
      return { status: 'connected', connected: true };
    }
    return { status: 'reconnecting' };
  }

  const authDir = path.join(__dirname, 'auth_sessions', sessionId);
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true,
    browser: ['Gorilla Spam', 'Chrome', '22.0'],
    generateHighQualityLinkPreview: false,
    markOnlineOnConnect: false,
  });

  sessions[sessionId] = {
    sock,
    qr: null,
    connected: false,
    phone: null,
  };

  // Handle credentials update
  sock.ev.on('creds.update', saveCreds);

  // Handle connection update
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      sessions[sessionId].qr = qr;
      sessions[sessionId].connected = false;
      logger.info(`[${sessionId}] QR Code generated`);
      await notifyWebhook('qr_updated', { session_id: sessionId, qr });
    }

    if (connection === 'open') {
      sessions[sessionId].qr = null;
      sessions[sessionId].connected = true;
      const phoneNumber = sock.user?.id?.split(':')[0] || null;
      sessions[sessionId].phone = phoneNumber;
      logger.info(`[${sessionId}] Connected! Phone: ${phoneNumber}`);
      await notifyWebhook('connected', { session_id: sessionId, phone: phoneNumber });
    }

    if (connection === 'close') {
      sessions[sessionId].connected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      logger.info(`[${sessionId}] Disconnected. Code: ${statusCode}. Reconnect: ${shouldReconnect}`);

      if (shouldReconnect) {
        // Reconnect after a delay
        setTimeout(() => startSession(sessionId), 3000);
      } else {
        // Logged out - clean up
        delete sessions[sessionId];
        if (fs.existsSync(authDir)) {
          fs.rmSync(authDir, { recursive: true, force: true });
        }
        await notifyWebhook('disconnected', { session_id: sessionId, reason: 'logged_out' });
      }
    }
  });

  // Handle incoming messages (forward to webhook)
  sock.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
    if (type !== 'notify') return;
    for (const msg of msgs) {
      if (msg.key.fromMe) continue;
      const phone = msg.key.remoteJid?.replace('@s.whatsapp.net', '') || '';
      const text = msg.message?.conversation ||
                   msg.message?.extendedTextMessage?.text ||
                   msg.message?.buttonsResponseMessage?.selectedDisplayText ||
                   msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
                   '';

      if (phone && text) {
        logger.info(`[${sessionId}] Message from ${phone}: ${text}`);
        await notifyWebhook('message_received', {
          session_id: sessionId,
          phone,
          message: text,
          message_id: msg.key.id,
        });
      }
    }
  });

  // Wait a bit for QR to generate
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const sessionState = sessions[sessionId];
  if (sessionState?.qr) {
    return { status: 'awaiting_qr', qr: sessionState.qr };
  }
  if (sessionState?.connected) {
    return { status: 'connected', connected: true };
  }
  return { status: 'reconnecting' };
}

// ===== ROUTES =====

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Gorilla Spam - Baileys Server', sessions: Object.keys(sessions).length });
});

// Start session
app.post('/start', async (req, res) => {
  try {
    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ error: 'session_id required' });
    const result = await startSession(session_id);
    res.json(result);
  } catch (e) {
    logger.error(`Start session error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// List sessions
app.get('/sessions', (req, res) => {
  const list = Object.entries(sessions).map(([id, s]) => ({
    session_id: id,
    connected: s.connected,
    has_qr: !!s.qr,
    phone: s.phone,
  }));
  res.json({ sessions: list });
});

// Get session status
app.get('/session/:id', (req, res) => {
  const s = sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'Session not found' });
  res.json({
    session_id: req.params.id,
    connected: s.connected,
    has_qr: !!s.qr,
    qr: s.qr,
    phone: s.phone,
  });
});

// Delete session
app.delete('/session/:id', async (req, res) => {
  const sessionId = req.params.id;
  const s = sessions[sessionId];
  if (s?.sock) {
    try { await s.sock.logout(); } catch {}
    try { s.sock.end(); } catch {}
  }
  delete sessions[sessionId];
  const authDir = path.join(__dirname, 'auth_sessions', sessionId);
  if (fs.existsSync(authDir)) {
    fs.rmSync(authDir, { recursive: true, force: true });
  }
  res.json({ success: true });
});

// Send text message
app.post('/send', async (req, res) => {
  try {
    const { session_id, phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });

    // Find session
    let sock;
    if (session_id && sessions[session_id]?.connected) {
      sock = sessions[session_id].sock;
    } else {
      // Use first connected session
      const connected = Object.values(sessions).find(s => s.connected);
      if (!connected) return res.status(400).json({ error: 'No connected session' });
      sock = connected.sock;
    }

    const jid = formatPhone(phone);
    await sock.sendMessage(jid, { text: message });
    logger.info(`Message sent to ${phone}`);
    res.json({ success: true, phone });
  } catch (e) {
    logger.error(`Send error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Send file (document/image)
app.post('/send-file', async (req, res) => {
  try {
    const { session_id, phone, file_url, file_name, caption } = req.body;
    if (!phone || !file_url) return res.status(400).json({ error: 'phone and file_url required' });

    // Find session
    let sock;
    if (session_id && sessions[session_id]?.connected) {
      sock = sessions[session_id].sock;
    } else {
      const connected = Object.values(sessions).find(s => s.connected);
      if (!connected) return res.status(400).json({ error: 'No connected session' });
      sock = connected.sock;
    }

    const jid = formatPhone(phone);

    // Download file
    const response = await axios.get(file_url, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(response.data);
    const name = file_name || 'file';
    const ext = path.extname(name).toLowerCase();

    // Determine message type based on extension
    let msgContent;
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
      msgContent = {
        image: buffer,
        caption: caption || '',
        fileName: name,
      };
    } else if (['.mp4', '.avi', '.mov'].includes(ext)) {
      msgContent = {
        video: buffer,
        caption: caption || '',
        fileName: name,
      };
    } else if (['.mp3', '.ogg', '.wav'].includes(ext)) {
      msgContent = {
        audio: buffer,
        mimetype: 'audio/mpeg',
        fileName: name,
      };
    } else {
      // Send as document (APK, PDF, etc.)
      msgContent = {
        document: buffer,
        mimetype: response.headers['content-type'] || 'application/octet-stream',
        fileName: name,
        caption: caption || '',
      };
    }

    await sock.sendMessage(jid, msgContent);
    logger.info(`File sent to ${phone}: ${name}`);
    res.json({ success: true, phone, file_name: name });
  } catch (e) {
    logger.error(`Send file error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ===== START SERVER =====

app.listen(PORT, () => {
  logger.info(`🦍 Gorilla Spam Baileys Server running on port ${PORT}`);
});
