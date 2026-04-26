/**
 * /api/memory — read/search/write memories + Twin insights.
 */
import { Router } from "express";
import { writeMemory, recentMemories, searchMemoryFTS, getTwinInsights } from "../../L2_memory/memory.js";
import { extractFromText } from "../../L2_memory/extractor.js";

const router = Router();

router.get("/", (req, res) => {
  const type = typeof req.query.type === "string" ? req.query.type as any : undefined;
  const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 30;
  res.json(recentMemories({ type, limit }));
});

router.get("/search", (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : "";
  const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 10;
  res.json(searchMemoryFTS(q, limit));
});

router.post("/", (req, res) => {
  const { type, title, content, tags, source, confidence } = req.body ?? {};
  if (!title || !content) return res.status(400).json({ error: "title + content required" });
  const id = writeMemory({ type: type ?? "episodic", title, content, tags, source, confidence });
  res.json({ id });
});

router.get("/twin/insights", (_req, res) => {
  res.json(getTwinInsights(30));
});

router.post("/extract", async (req, res) => {
  const { text } = req.body ?? {};
  if (!text) return res.status(400).json({ error: "text required" });
  try {
    const r = await extractFromText(text);
    res.json(r);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
