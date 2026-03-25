const messageQueue = require("../services/MessageQueue");

exports.sendMessage = async (req, res) => {
  try {
    const { session_id, phone, message } = req.body;
    if (!phone || !message) {
      return res.status(400).json({ error: "phone e message são obrigatórios" });
    }

    const result = await messageQueue.sendMessage(
      session_id || null,
      phone,
      message
    );
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.queueMessages = (req, res) => {
  try {
    const { recipients, message, delay_seconds = 5 } = req.body;
    if (!recipients?.length || !message) {
      return res.status(400).json({ error: "recipients e message são obrigatórios" });
    }

    const result = messageQueue.enqueue(recipients, message, delay_seconds);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.queueStatus = (req, res) => {
  res.json(messageQueue.getStatus());
};
