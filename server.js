import express from "express";
import { listarFeriados } from "./src/feriados.js";

const app = express();

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get("/api/feriados", async (req, res) => {
  try {
    const anoRaw = req.query.ano ?? req.query.year ?? new Date().getFullYear();
    const uf = req.query.uf ?? req.query.estado ?? null;
    const cidade = req.query.cidade ?? null;

    const payload = await listarFeriados({ ano: anoRaw, uf, cidade });

    res
      .status(200)
      .setHeader("cache-control", "public, max-age=3600")
      .json(payload);
  } catch (err) {
    res.status(400).json({
      ok: false,
      error: err instanceof Error ? err.message : "Erro desconhecido",
    });
  }
});

const port = Number.parseInt(process.env.PORT ?? "4000", 10);
app.listen(port, () => {
  process.stdout.write(`API on http://localhost:${port}\n`);
});
