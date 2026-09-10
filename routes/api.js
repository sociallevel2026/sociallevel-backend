// routes/api.js
const express = require("express");
const router = express.Router();
const db = require("../db");
const { evaluarCicloCompleto } = require("../services/evaluar");

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
  if (activos.length) return res.json(activos[0]);

  // Si no hay ninguno "activo" (por ejemplo, el último se acaba de cerrar y
  // todavía no se ha creado el siguiente), devuelve el más reciente que
  // exista igual — así la app siempre tiene algo que mostrar, aunque sea
  // en estado "cerrado" o "evaluando".
  const todos = db.all("cycles").sort((a, b) => b.id - a.id);
  if (!todos.length) return res.status(404).json({ error: "No hay ningún ciclo creado todavía" });
  res.json(todos[0]);
});

router.get("/cycles/:id", (req, res) => {
  const cycle = db.findById("cycles", req.params.id);
  if (!cycle) return res.status(404).json({ error: "Ciclo no encontrado" });
  res.json(cycle);
});

router.patch("/cycles/:id/phase", (req, res) => {
  const { phase } = req.body; // apertura | exploracion | construccion | cierre
  const cycle = db.update("cycles", Number(req.params.id), { phase });
  if (!cycle) return res.status(404).json({ error: "Ciclo no encontrado" });
  res.json({ ok: true, phase });
});

// Cierra el ciclo Y dispara la evaluación por lote de todos sus mensajes de
// una sola vez — este es el único momento en que se llama a la IA para
// evaluar contenido de este ciclo (ver services/evaluar.js para el porqué).
router.post("/cycles/:id/close", async (req, res) => {
  const cycleId = Number(req.params.id);
  const cycle = db.findById("cycles", cycleId);
  if (!cycle) return res.status(404).json({ error: "Ciclo no encontrado" });

  db.update("cycles", cycleId, { status: "evaluando" }); // estado intermedio mientras la IA procesa

  // Responde de inmediato — cerrar y evaluar un ciclo con muchos mensajes
  // puede tardar. El cliente puede consultar GET /cycles/:id para ver cuándo
  // pasa a "cerrado".
  res.json({ ok: true, status: "evaluando" });

  try {
    const pendientes = db.find("messages", (m) => m.cycle_id === cycleId && !m.evaluated_at);

    const mensajesParaIA = pendientes.map((m) => {
      const autor = db.findById("users", m.user_id);
      let respuestaA = null;
      if (m.reply_to_id) {
        const original = db.findById("messages", m.reply_to_id);
        respuestaA = original ? original.text : null;
      }
      return {
        id: m.id, autor: autor ? autor.name : "Usuario",
        texto: m.text, fase: m.phase, respuestaA,
      };
    });

    if (mensajesParaIA.length > 0) {
      const evaluaciones = await evaluarCicloCompleto({
        problema: { titulo: cycle.title, contexto: cycle.context, criterio_exito: cycle.success_criteria },
        mensajes: mensajesParaIA,
      });

      evaluaciones.forEach((ev) => {
        db.update("messages", ev.id, {
          role: ev.rol, pertinente: ev.pertinente,
          relevancia: ev.relevancia, originalidad: ev.originalidad,
          traccion: ev.traccion, fundamentacion: ev.fundamentacion,
          claridad: ev.claridad, total: ev.total,
          justificacion: ev.justificacion_breve,
          evaluated_at: new Date().toISOString(),
        });
      });

      // Aplica XP y conteo de rol por usuario, ahora que todos los mensajes
      // del lote ya tienen su evaluación guardada.
      evaluaciones.forEach((ev) => {
        const msgOriginal = pendientes.find((p) => p.id === ev.id);
        if (!msgOriginal) return;
        const user = db.findById("users", msgOriginal.user_id);
        if (!user) return;
        const xpGained = Math.round(ev.total / 4);
        const roleCol = "role_" + ev.rol;
        db.update("users", user.id, { xp: user.xp + xpGained, [roleCol]: (user[roleCol] || 0) + 1 });
      });
    }

    // Arma el portafolio: rol dominante y puntaje promedio por persona,
    // usando ya los mensajes evaluados de este cierre.
    const mensajesCiclo = db.find("messages", (m) => m.cycle_id === cycleId && m.role);
    const porUsuario = {};
    mensajesCiclo.forEach((m) => {
      porUsuario[m.user_id] = porUsuario[m.user_id] || {};
      porUsuario[m.user_id][m.role] = porUsuario[m.user_id][m.role] || { count: 0, sumTotal: 0 };
      porUsuario[m.user_id][m.role].count += 1;
      porUsuario[m.user_id][m.role].sumTotal += m.total;
    });
    Object.entries(porUsuario).forEach(([userId, roles]) => {
      const [dominantRole, stats] = Object.entries(roles).sort((a, b) => b[1].count - a[1].count)[0];
      db.insert("portfolio", {
        user_id: Number(userId), cycle_id: cycleId,
        dominant_role: dominantRole, score: Math.round(stats.sumTotal / stats.count),
        created_at: new Date().toISOString(),
      });
    });

    db.update("cycles", cycleId, { status: "cerrado", closed_at: new Date().toISOString() });
  } catch (err) {
    console.error("Error evaluando el ciclo", cycleId, err.message);
    db.update("cycles", cycleId, { status: "cerrado", closed_at: new Date().toISOString(), error_evaluacion: err.message });
  }
});

// ---------- Mensajes ----------
// Solo GUARDA el mensaje — ya no evalúa aquí. La evaluación real pasa una
// sola vez, en lote, cuando se cierra el ciclo (ver /cycles/:id/close).
router.post("/messages", (req, res) => {
  const { cycle_id, user_id, text, reply_to_id } = req.body;
  if (!cycle_id || !user_id || !text) return res.status(400).json({ error: "cycle_id, user_id y text son requeridos" });

  const cycle = db.findById("cycles", cycle_id);
  if (!cycle) return res.status(404).json({ error: "Ciclo no encontrado" });

  const message = db.insert("messages", {
    cycle_id: Number(cycle_id), user_id: Number(user_id), phase: cycle.phase, text,
    reply_to_id: reply_to_id ? Number(reply_to_id) : null,
    role: null, pertinente: null, relevancia: null, originalidad: null, traccion: null,
    fundamentacion: null, claridad: null, total: null, justificacion: null,
    evaluated_at: null, created_at: new Date().toISOString(),
  });

  res.json({ id: message.id, status: "pendiente" });
});

router.get("/messages/:id", (req, res) => {
  const msg = db.findById("messages", req.params.id);
  if (!msg) return res.status(404).json({ error: "Mensaje no encontrado" });
  const status = msg.error ? "error" : (msg.evaluated_at ? "evaluado" : "pendiente");
  res.json({ ...msg, status });
});

router.get("/cycles/:id/messages", (req, res) => {
  const rows = db.find("messages", (m) => m.cycle_id === Number(req.params.id))
    .sort((a, b) => a.id - b.id)
    .map((m) => ({
      ...m,
      autor: db.findById("users", m.user_id)?.name || "Usuario",
      status: m.error ? "error" : (m.evaluated_at ? "evaluado" : "pendiente"),
    }));
  res.json(rows);
});

module.exports = router;
