const sessionManager = require("./SessionManager");

class MessageQueue {
  constructor() {
    /** @type {Array<{phone: string, message: string, sessionId?: string, leadId?: string, name?: string, resolve: Function, reject: Function}>} */
    this.queue = [];
    this.processing = false;
    this.delayMs = 5000; // delay padrão: 5 segundos
    this.currentSessionIndex = 0;
    this.results = [];
  }

  /** Configura o delay entre mensagens (mínimo 5s) */
  setDelay(seconds) {
    this.delayMs = Math.max(5000, seconds * 1000);
  }

  /** Adiciona mensagens à fila */
  enqueue(recipients, message, delaySeconds = 5) {
    this.setDelay(delaySeconds);
    const connected = sessionManager.getConnectedSessions();
    if (connected.length === 0) {
      throw new Error("Nenhuma sessão conectada disponível");
    }

    const promises = recipients.map((recipient) => {
      return new Promise((resolve, reject) => {
        // Round-robin: distribuir entre sessões
        const sessionId = connected[this.currentSessionIndex % connected.length].session_id;
        this.currentSessionIndex++;

        // Substituir variáveis na mensagem
        let finalMessage = message
          .replace(/\{\{nome\}\}/g, recipient.name || "")
          .replace(/\{\{produto\}\}/g, recipient.product || "");

        this.queue.push({
          phone: recipient.phone,
          message: finalMessage,
          sessionId,
          leadId: recipient.lead_id,
          name: recipient.name,
          resolve,
          reject,
        });
      });
    });

    // Iniciar processamento se não estiver ativo
    if (!this.processing) {
      this.processQueue();
    }

    return {
      queued: recipients.length,
      sessions_used: connected.length,
    };
  }

  /** Processa a fila sequencialmente com delay */
  async processQueue() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    console.log(`[Queue] Iniciando processamento — ${this.queue.length} mensagens na fila`);

    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) break;

      try {
        const result = await this.sendMessage(item.sessionId, item.phone, item.message);
        item.resolve({ phone: item.phone, success: true, ...result });
        console.log(`[Queue] ✅ Enviada para ${item.phone} via ${item.sessionId}`);
      } catch (err) {
        item.resolve({ phone: item.phone, success: false, error: err.message });
        console.error(`[Queue] ❌ Falha para ${item.phone}:`, err.message);
      }

      // Delay entre mensagens
      if (this.queue.length > 0) {
        await this.sleep(this.delayMs);
      }
    }

    this.processing = false;
    console.log("[Queue] Fila processada");
  }

  /** Envia uma mensagem via Baileys */
  async sendMessage(sessionId, phone, message) {
    const session = sessionManager.getSession(sessionId);
    if (!session || session.status !== "connected") {
      throw new Error(`Sessão ${sessionId} não está conectada`);
    }

    // Formatar número (adicionar @s.whatsapp.net)
    const jid = this.formatJid(phone);

    const result = await session.socket.sendMessage(jid, { text: message });
    return { messageId: result.key.id };
  }

  /** Formata número para JID do WhatsApp */
  formatJid(phone) {
    let clean = phone.replace(/\D/g, "");
    // Adicionar código do país se não tiver
    if (clean.length <= 11) clean = "55" + clean;
    return clean + "@s.whatsapp.net";
  }

  /** Retorna status da fila */
  getStatus() {
    return {
      pending: this.queue.length,
      processing: this.processing,
      delay_ms: this.delayMs,
    };
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = new MessageQueue();
