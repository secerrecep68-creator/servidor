const { Router } = require("express");
const ctrl = require("../controllers/messageController");

const router = Router();

router.post("/send", ctrl.sendMessage);
router.post("/queue", ctrl.queueMessages);
router.get("/queue/status", ctrl.queueStatus);

module.exports = router;
