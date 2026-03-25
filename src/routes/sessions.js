const { Router } = require("express");
const ctrl = require("../controllers/sessionController");

const router = Router();

router.post("/start", ctrl.startSession);
router.get("/sessions", ctrl.listSessions);
router.get("/session/:id", ctrl.getSession);
router.delete("/session/:id", ctrl.removeSession);

module.exports = router;
