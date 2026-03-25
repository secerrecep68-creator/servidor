const express = require("express");
const cors = require("cors");
const sessionRoutes = require("./routes/sessions");
const messageRoutes = require("./routes/messages");
const sessionManager = require("./services/SessionManager");

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json());

// Log de requisições
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Rotas
app.use("/", sessionRoutes);
app.use("/", messageRoutes);

// Health check
app.get("/health", (req, res) => {
  const sessions = sessionManager.listSessions();
  res.json({
    status: "ok",
    uptime: process.uptime(),
    sessions: sessions.length,
    connected: sessions.filter((s) => s.status === "connected").length,
  });
});

// Iniciar servidor e restaurar sessões
app.listen(PORT, async () => {
  console.log(`\n🚀 Baileys Server rodando na porta ${PORT}`);
  console.log(`📡 Health: http://localhost:${PORT}/health`);
  console.log(`📋 Sessões: http://localhost:${PORT}/sessions\n`);

  // Restaurar sessões salvas
  await sessionManager.restoreSessions();
});
