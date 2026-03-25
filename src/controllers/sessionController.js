const sessionManager = require("../services/SessionManager");

exports.startSession = async (req, res) => {
  try {
    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ error: "session_id obrigatório" });

    const session = await sessionManager.startSession(session_id);
    res.json({
      session_id,
      status: session.status,
      qr: session.qr,
      phone: session.phone,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.listSessions = (req, res) => {
  res.json(sessionManager.listSessions());
};

exports.getSession = (req, res) => {
  const session = sessionManager.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Sessão não encontrada" });
  res.json({
    session_id: req.params.id,
    status: session.status,
    qr: session.qr,
    phone: session.phone,
  });
};

exports.removeSession = async (req, res) => {
  try {
    await sessionManager.removeSession(req.params.id);
    res.json({ success: true, message: `Sessão ${req.params.id} removida` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
