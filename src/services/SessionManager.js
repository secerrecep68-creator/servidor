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
