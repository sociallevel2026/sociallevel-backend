// routes/api.js
const express = require("express");
const router = express.Router();
const db = require("../db");
const { evaluarMensaje } = require("../services/evaluar");

// ---------- Usuarios ----------
router.post("/users", (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).json({ error: "name y email son requeridos" });
  if (db.findOne("users", (u) => u.email === email)) {
    return res.status(400).json({ error: "Ese email ya existe" });
  }
  const user = db.insert("users", {
    name, email, xp: 0,
    role_generador: 0, role_constructor: 0, role_verificador: 0, role_sintetizador: 0,
    created_at: new Date().toISOString(),
  });
  res.json(user);
});

router.get("/users/:id", (req, res) => {
  const user = db.findById("users", req.params.id);
  if (!user) return res.status(404).json({ error: "Usuario no encontrado" });
  const portfolio = db.find("portfolio", (p) => p.user_id === Number(req.params.id))
    .map((p) => ({ ...p, title: db.findById("cycles", p.cycle_id)?.title || "" }))
    .sort((a, b) => b.id - a.id);
  res.json({ ...user, portfolio });
});

// ---------- Problemas / Ciclos ----------
router.post("/cycles", (req, res) => {
  const { title, context, success_criteria } = req.body;
  if (!title || !context || !success_criteria) return res.status(400).json({ error: "title, context y success_criteria son requeridos" });
  const maxNumber = db.all("cycles").reduce((max, c) => Math.max(max, c.number), 0);
  const cycle = db.insert("cycles", {
    number: maxNumber + 1, title, context, success_criteria,
    phase: "exploracion", status: "activo",
    opened_at: new Date().toISOString(), closed_at: null,
  });
  res.json(cycle);
});

router.get("/cycles/active", (req, res) => {
  const activos = db.find("cycles", (c) => c.status === "activo").sort((a, b) => b.id - a.id);
  if (!activos.length) return res.status(404).json({ error: "No hay ciclo activo" });
  res.json(activos[0]);
});

router.patch("/cycles/:id/phase", (req, res) => {
  const { phase } = req.body; // apertura | exploracion | construccion | cierre
  const cycle = db.update("cycles", Number(req.params.id), { phase });
  if (!cycle) return res.status(404).json({ error: "Ciclo no encontrado" });
  res.json({ ok: true, phase });
});

router.post("/cycles/:id/close", (req, res) => {
  const cycleId = Number(req.params.id);
  const cycle = db.update("cycles", cycleId, { status: "cerrado", closed_at: new Date().toISOString() });
  if (!cycle) return res.status(404).json({ error: "Ciclo no encontrado" });

  // Agrupa los mensajes evaluados de este ciclo por usuario+rol, toma el rol
  // más frecuente de cada persona, y registra una entrada en su portafolio.
  const mensajesCiclo = db.find("messages", (m) => m.cycle_id === cycleId && m.role);
  const porUsuario = {};
  mensajesCiclo.forEach((m) => {
    porUsuario[m.user_id] = porUsuario[m.user_id] || {};
    porUsuario[m.user_id][m.role] = porUsuario[m.user_id][m.role] || { count: 0, sumTotal: 0 };
    porUsuario[m.user_id][m.role].count += 1;
    porUsuario[m.user_id][m.role].sumTotal += m.total;
  });

  let entries = 0;
  Object.entries(porUsuario).forEach(([userId, roles]) => {
    const [dominantRole, stats] = Object.entries(roles).sort((a, b) => b[1].count - a[1].count)[0];
    db.insert("portfolio", {
      user_id: Number(userId), cycle_id: cycleId,
      dominant_role: dominantRole, score: Math.round(stats.sumTotal / stats.count),
      created_at: new Date().toISOString(),
    });
    entries += 1;
  });

  res.json({ ok: true, entries });
});

// ---------- Mensajes (el corazón: enviar + evaluar) ----------
router.post("/messages", async (req, res) => {
  const { cycle_id, user_id, text, reply_to_id } = req.body;
  if (!cycle_id || !user_id || !text) return res.status(400).json({ error: "cycle_id, user_id y text son requeridos" });

  const cycle = db.findById("cycles", cycle_id);
  if (!cycle) return res.status(404).json({ error: "Ciclo no encontrado" });

  const message = db.insert("messages", {
    cycle_id: Number(cycle_id), user_id: Number(user_id), phase: cycle.phase, text,
    reply_to_id: reply_to_id ? Number(reply_to_id) : null,
    role: null, relevancia: null, originalidad: null, traccion: null,
    fundamentacion: null, claridad: null, total: null, justificacion: null,
    evaluated_at: null, created_at: new Date().toISOString(),
  });

  // Responde de inmediato — el frontend muestra "evaluando" y consulta
  // /messages/:id un momento después para ver el resultado.
  res.json({ id: message.id, status: "evaluando" });

  // Evaluación asíncrona (no bloquea la respuesta al usuario)
  try {
    const historialMsgs = db.find("messages", (m) => m.cycle_id === Number(cycle_id) && m.id !== message.id)
      .sort((a, b) => b.id - a.id).slice(0, 6).reverse();
    const historial = historialMsgs.map((m) => {
      const autor = db.findById("users", m.user_id);
      return `${autor ? autor.name : "Usuario"}: ${m.text}`;
    }).join("\n");

    const autorObj = db.findById("users", user_id);
    const autor = autorObj ? autorObj.name : "Usuario";

    let respuestaA = null;
    if (reply_to_id) {
      const original = db.findById("messages", reply_to_id);
      respuestaA = original ? original.text : null;
    }

    const evalResult = await evaluarMensaje({
      problema: { titulo: cycle.title, contexto: cycle.context, criterio_exito: cycle.success_criteria },
      historial, mensaje: text, autor, respuestaA, fase: cycle.phase,
    });

    db.update("messages", message.id, {
      role: evalResult.rol,
      relevancia: evalResult.relevancia, originalidad: evalResult.originalidad,
      traccion: evalResult.traccion, fundamentacion: evalResult.fundamentacion,
      claridad: evalResult.claridad, total: evalResult.total,
      justificacion: evalResult.justificacion_breve,
      evaluated_at: new Date().toISOString(),
    });

    const xpGained = Math.round(evalResult.total / 4);
    const roleCol = "role_" + evalResult.rol;
    const user = db.findById("users", user_id);
    if (user) {
      db.update("users", user.id, { xp: user.xp + xpGained, [roleCol]: (user[roleCol] || 0) + 1 });
    }
  } catch (err) {
    console.error("Error evaluando mensaje", message.id, err.message);
    db.update("messages", message.id, {
      justificacion: "Error de evaluación: " + err.message,
      evaluated_at: new Date().toISOString(),
      error: true,
    });
  }
});

router.get("/messages/:id", (req, res) => {
  const msg = db.findById("messages", req.params.id);
  if (!msg) return res.status(404).json({ error: "Mensaje no encontrado" });
  const status = msg.error ? "error" : (msg.evaluated_at ? "evaluado" : "evaluando");
  res.json({ ...msg, status });
});

router.get("/cycles/:id/messages", (req, res) => {
  const rows = db.find("messages", (m) => m.cycle_id === Number(req.params.id))
    .sort((a, b) => a.id - b.id)
    .map((m) => ({ ...m, autor: db.findById("users", m.user_id)?.name || "Usuario" }));
  res.json(rows);
});

module.exports = router;
