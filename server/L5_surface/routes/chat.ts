/**
 * /api/chat — general chatbot.
 */
import { Router } from "express";
import { chat } from "../../L3_cognition/chat.js";

const router = Router();

router.post("/", async (req, res) => {
  const { message, history } = req.body ?? {};
  if (!message) return res.status(400).json({ error: "message required" });
  try {
    const text = await chat(message, history);
    res.json({ text });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
