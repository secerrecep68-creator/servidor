const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const path = require("path");
const fs = require("fs");
const QRCode = require("qrcode");
const pino = require("pino");

const logger = pino({ level: "warn" });
const MAX_SESSIONS = 5;
const SESSIONS_DIR = path.join(__dirname, "..", "..", "sessions");

class SessionManager {
  constructor() {
    /** @type {Map<string, {socket: any, status: string, qr: string|null, phone: string|null}>} */
    this.sessions = new Map();
    if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }

  /** Restaura sessões salvas ao iniciar o servidor */
  async restoreSessions() {
    if (!fs.existsSync(SESSIONS_DIR)) return;
    const dirs = fs.readdirSync(SESSIONS_DIR).filter((d) =>
      fs.statSync(path.join(SESSIONS_DIR, d)).isDirectory()
    );
    for (const sessionId of dirs) {
      console.log(`[SessionManager] Restaurando sessão: ${sessionId}`);
      try {
        await this.startSession(sessionId);
      } catch (err) {
        console.error(`[SessionManager] Erro ao restaurar ${sessionId}:`, err.message);
      }
    }
  }

  /** Inicia uma nova sessão ou reconecta uma existente */
  async startSession(sessionId) {
    if (this.sessions.size >= MAX_SESSIONS && !this.sessions.has(sessionId)) {
      throw new Error(`Limite de ${MAX_SESSIONS} sessões atingido`);
    }

    const sessionPath = path.join(SESSIONS_DIR, sessionId);
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const socket = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: true,
      logger,
      browser: ["SpamPanel", "Chrome", "1.0.0"],
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 0,
      keepAliveIntervalMs: 25000,
      retryRequestDelayMs: 500,
    });

    const sessionData = { socket, status: "connecting", qr: null, phone: null };
    this.sessions.set(sessionId, sessionData);

    // Salvar credenciais quando atualizar
    socket.ev.on("creds.update", saveCreds);

    // Encaminhar mensagens recebidas ao webhook do Supabase
    socket.ev.on("messages.upsert", async ({ messages: msgs, type }) => {
      // Ignorar notificações de histórico/sincronização; processar apenas mensagens novas
      if (type !== "notify") return;

      const webhookUrl = process.env.WEBHOOK_URL;
      if (!webhookUrl) return;

      for (const msg of msgs) {
        // Ignorar mensagens enviadas pelo próprio número
        if (msg.key?.fromMe) continue;

        try {
          const from = msg.key?.remoteJid?.replace(/@.+$/, "") || null;
          const timestamp = msg.messageTimestamp
            ? new Date(Number(msg.messageTimestamp) * 1000).toISOString()
            : new Date().toISOString();

          // Determinar tipo e conteúdo da mensagem
          let messageType = "unknown";
          let messageContent = null;

          if (msg.message?.conversation) {
            messageType = "text";
            messageContent = msg.message.conversation;
          } else if (msg.message?.extendedTextMessage?.text) {
            messageType = "text";
            messageContent = msg.message.extendedTextMessage.text;
          } else if (msg.message?.imageMessage) {
            messageType = "image";
            messageContent = msg.message.imageMessage.caption || null;
          } else if (msg.message?.videoMessage) {
            messageType = "video";
            messageContent = msg.message.videoMessage.caption || null;
          } else if (msg.message?.audioMessage) {
            messageType = "audio";
            messageContent = null;
          } else if (msg.message?.documentMessage) {
            messageType = "document";
            messageContent = msg.message.documentMessage.fileName || null;
          } else if (msg.message?.stickerMessage) {
            messageType = "sticker";
            messageContent = null;
          } else if (msg.message?.locationMessage) {
            messageType = "location";
            messageContent = null;
          } else if (msg.message?.contactMessage) {
            messageType = "contact";
            messageContent = msg.message.contactMessage.displayName || null;
          }

          const payload = {
            session_id: sessionId,
            from,
            message: messageContent,
            timestamp,
            type: messageType,
          };

          const response = await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });

          if (!response.ok) {
            console.error(
              `[${sessionId}] ⚠️ Webhook retornou ${response.status} para mensagem de ${from}`
            );
          } else {
            console.log(`[${sessionId}] 📨 Mensagem de ${from} (${messageType}) enviada ao webhook`);
          }
        } catch (err) {
          console.error(`[${sessionId}] ❌ Erro ao enviar mensagem ao webhook:`, err.message);
        }
      }
    });

    // Evento de conexão
    socket.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        // Gerar QR como data URL para o frontend
        try {
          const qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
          sessionData.qr = qrDataUrl;
          sessionData.status = "awaiting_qr";
          console.log(`[${sessionId}] QR Code gerado — escaneie no WhatsApp`);
        } catch (err) {
          console.error(`[${sessionId}] Erro ao gerar QR:`, err);
        }
      }

      if (connection === "open") {
        sessionData.status = "connected";
        sessionData.qr = null;
        sessionData.phone = socket.user?.id?.split(":")[0] || null;
        console.log(`[${sessionId}] ✅ Conectado — ${sessionData.phone}`);
      }

      if (connection === "close") {
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (shouldReconnect) {
          console.log(`[${sessionId}] ⚠️ Desconectado (${statusCode}) — reconectando em 5s...`);
          sessionData.status = "reconnecting";
          setTimeout(() => this.startSession(sessionId), 5000);
        } else {
          console.log(`[${sessionId}] ❌ Logout — sessão removida`);
          this.sessions.delete(sessionId);
          // Limpar arquivos da sessão
          if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
          }
        }
      }
    });

    return sessionData;
  }

  /** Remove uma sessão */
  async removeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session?.socket) {
      try {
        await session.socket.logout();
      } catch {
        session.socket.end();
      }
    }
    this.sessions.delete(sessionId);

    const sessionPath = path.join(SESSIONS_DIR, sessionId);
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }
    console.log(`[${sessionId}] Sessão removida`);
  }

  /** Lista todas as sessões */
  listSessions() {
    const list = [];
    for (const [id, data] of this.sessions) {
      list.push({
        session_id: id,
        status: data.status,
        phone: data.phone,
        qr: data.qr,
      });
    }
    return list;
  }

  /** Retorna sessões conectadas */
  getConnectedSessions() {
    return this.listSessions().filter((s) => s.status === "connected");
  }

  /** Pega uma sessão específica */
  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }
}

module.exports = new SessionManager();
