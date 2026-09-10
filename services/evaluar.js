// services/evaluar.js — motor de evaluación real, usando DeepSeek.
//
// ARQUITECTURA: evaluación POR LOTE al cierre del ciclo, no por mensaje en
// tiempo real. Razones (decisión tomada en conversación con el fundador):
//   1. Costo — el contexto del problema y la rúbrica se envían UNA vez para
//      todo el ciclo, no una vez por cada mensaje.
//   2. Calidad — la IA ve el hilo completo de una vez, así que puede juzgar
//      mejor originalidad y tracción (ej. detecta que dos personas propusieron
//      lo mismo, algo casi imposible de ver evaluando mensaje por mensaje).
//   3. Incentivos — nadie ve su puntaje en vivo, así que no hay forma de
//      "escribir para el número" en vez de para el problema real.
//
// NOTA: DeepSeek procesa los datos en servidores en China y no ofrece SOC 2
// ni DPA/GDPR. Válido para pruebas, MVP interno o el Camino C (Comunidades
// Ancla) — para el Camino B (clientes B2B con datos de negocio reales), la
// recomendación sigue siendo Claude u otro proveedor con certificaciones
// empresariales. Queda documentado aquí para que la decisión no se pierda.
const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});

// Pesos por fase — igual que en el prototipo (PHASE_WEIGHTS en index.html)
const PHASE_WEIGHTS = {
  exploracion:  { relevancia: 30, originalidad: 30, traccion: 10, fundamentacion: 20, claridad: 10 },
  construccion: { relevancia: 20, originalidad: 10, traccion: 35, fundamentacion: 25, claridad: 10 },
  cierre:       { relevancia: 20, originalidad: 5,  traccion: 15, fundamentacion: 20, claridad: 40 },
};

const SYSTEM_PROMPT_LOTE = `Eres el motor de evaluación de SocialLevel, una plataforma donde equipos
resuelven problemas reales en ciclos de 48 horas. Vas a evaluar TODOS los
aportes de un ciclo YA CERRADO, de una sola vez, con el hilo completo como
contexto — no participas en la conversación, no das opiniones, únicamente
evalúas cada mensaje según la rúbrica.

Para CADA mensaje de la lista, sigue este proceso:

PASO 1 — Decide si es "pertinente": un intento genuino de aportar al problema
planteado. NO es pertinente si es ruido sin sentido, spam, un saludo suelto
sin contenido, texto aleatorio, groserías sin argumento, o cualquier cosa que
no intente responder al problema — sin importar qué tan bien escrito esté.

PASO 2 — Si NO es pertinente: los cinco criterios deben quedar entre 0 y 8, y
"total" no puede superar 5.

PASO 3 — Si SÍ es pertinente, evalúa con estos cinco criterios (0-100 cada uno):
- relevancia: ¿responde directamente al problema y a su criterio de éxito?
- originalidad: ¿aporta algo no dicho antes en el hilo? Como ves el hilo
  completo, si dos personas proponen básicamente lo mismo, la segunda NO es
  tan original como la primera — compara entre mensajes, no solo contra el
  problema.
- traccion: ¿construye sobre un aporte anterior, o generó que otros
  construyeran sobre él? Con el hilo completo puedes confirmar esto de verdad,
  no adivinarlo.
- fundamentacion: ¿hay razonamiento, datos o evidencia?
- claridad: ¿se entiende sin esfuerzo excesivo?

Cada mensaje trae su fase y los pesos exactos de esa fase — calcula "total"
como el promedio ponderado exacto con esos pesos, redondeado al entero más
cercano. Los pesos cambian entre mensajes si el ciclo avanzó de fase mientras
se escribían.

Ejemplos de calibración (aplican siempre):
- "jajaja banana asdf" → pertinente:false, todos los criterios 0-3, total 0-2.
- "hola buenos días" (sin contenido sobre el problema) → pertinente:false, total 0-3.
- "no sé, tal vez algo con IA?" → pertinente:true (intento real, aunque débil).
- Una idea concreta con un dato o ejemplo → pertinente:true, rúbrica normal.

Clasifica cada mensaje en un único rol dominante: "generador" (idea nueva,
independiente), "constructor" (mejora o extiende un aporte ajeno),
"verificador" (cuestiona o señala un riesgo con fundamento), o "sintetizador"
(resume o consolida la discusión). Si pertinente:false, usa "generador" por
defecto.

Devuelve exactamente una evaluación por cada ID de mensaje que se te dio, sin
saltarte ninguno y sin inventar IDs nuevos. Responde ÚNICAMENTE llamando a la
función solicitada, sin texto adicional.`;

const TOOL_SCHEMA_LOTE = {
  type: "function",
  function: {
    name: "evaluar_ciclo",
    description: "Evalúa todos los mensajes de un ciclo cerrado de la Arena de Problemas, de una sola vez",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        evaluaciones: {
          type: "array",
          description: "Una evaluación por cada mensaje recibido, en el mismo orden",
          items: {
            type: "object",
            properties: {
              id: { type: "integer", description: "El ID del mensaje evaluado, tal como se recibió" },
              pertinente: { type: "boolean" },
              relevancia: { type: "integer", description: "0-100" },
              originalidad: { type: "integer", description: "0-100" },
              traccion: { type: "integer", description: "0-100" },
              fundamentacion: { type: "integer", description: "0-100" },
              claridad: { type: "integer", description: "0-100" },
              total: { type: "integer", description: "Promedio ponderado 0-100" },
              rol: { type: "string", enum: ["generador", "constructor", "verificador", "sintetizador"] },
              justificacion_breve: { type: "string", description: "Máximo 20 palabras" },
            },
            required: ["id", "pertinente", "relevancia", "originalidad", "traccion", "fundamentacion", "claridad", "total", "rol", "justificacion_breve"],
            additionalProperties: false,
          },
        },
      },
      required: ["evaluaciones"],
      additionalProperties: false,
    },
  },
};

// mensajes: [{ id, autor, texto, fase, respuestaA (texto o null) }]
async function evaluarCicloCompleto({ problema, mensajes }) {
  if (!mensajes.length) return [];

  const listaTexto = mensajes.map((m) => {
    const pesos = PHASE_WEIGHTS[m.fase] || PHASE_WEIGHTS.exploracion;
    const bloqueRespuesta = m.respuestaA ? `\n   (Responde a: "${m.respuestaA}")` : "";
    return `[ID ${m.id}] Fase: ${m.fase} — pesos: relevancia ${pesos.relevancia}%, originalidad ${pesos.originalidad}%, tracción ${pesos.traccion}%, fundamentación ${pesos.fundamentacion}%, claridad ${pesos.claridad}%
${m.autor}: "${m.texto}"${bloqueRespuesta}`;
  }).join("\n\n");

  const userPrompt = `PROBLEMA DEL CICLO:
Título: ${problema.titulo}
Contexto: ${problema.contexto}
Criterio de éxito: ${problema.criterio_exito}

Este ciclo ya cerró. Evalúa TODOS los mensajes de abajo, en orden cronológico,
usando el hilo completo como contexto para comparar originalidad y tracción
entre ellos.

MENSAJES A EVALUAR (${mensajes.length} en total):

${listaTexto}

Devuelve una evaluación por cada uno de los ${mensajes.length} IDs de arriba.`;

  const response = await client.chat.completions.create({
    model: "deepseek-chat",
    temperature: 0.2,
    messages: [
      { role: "system", content: SYSTEM_PROMPT_LOTE },
      { role: "user", content: userPrompt },
    ],
    tools: [TOOL_SCHEMA_LOTE],
    tool_choice: { type: "function", function: { name: "evaluar_ciclo" } },
  });

  const toolCall = response.choices[0].message.tool_calls?.[0];
  if (!toolCall) throw new Error("DeepSeek no devolvió evaluaciones para el ciclo");
  const result = JSON.parse(toolCall.function.arguments);

  // Misma salvaguarda de código que antes, aplicada a cada mensaje del lote:
  // no confiamos ciegamente en que el modelo respete "pertinente:false ->
  // puntajes casi cero" — lo forzamos aquí, sin excepción.
  result.evaluaciones.forEach((ev) => {
    if (ev.pertinente === false) {
      const cap = 5;
      ev.relevancia = Math.min(ev.relevancia, cap);
      ev.originalidad = Math.min(ev.originalidad, cap);
      ev.traccion = Math.min(ev.traccion, cap);
      ev.fundamentacion = Math.min(ev.fundamentacion, cap);
      ev.claridad = Math.min(ev.claridad, cap);
      ev.total = Math.min(ev.total, cap);
    }
  });

  return result.evaluaciones;
}

module.exports = { evaluarCicloCompleto, PHASE_WEIGHTS };


