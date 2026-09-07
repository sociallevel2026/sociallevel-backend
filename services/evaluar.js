// services/evaluar.js — motor de evaluación real, usando DeepSeek.
// Mismo prompt y misma rúbrica que DeepSeek_Prompt_Evaluacion.md — pesos por
// fase igual que en el prototipo (build/index.html, PHASE_WEIGHTS).
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

// Pesos por fase — igual que en el prototipo
const PHASE_WEIGHTS = {
  exploracion:  { relevancia: 30, originalidad: 30, traccion: 10, fundamentacion: 20, claridad: 10 },
  construccion: { relevancia: 20, originalidad: 10, traccion: 35, fundamentacion: 25, claridad: 10 },
  cierre:       { relevancia: 20, originalidad: 5,  traccion: 15, fundamentacion: 20, claridad: 40 },
};

const SYSTEM_PROMPT = `Eres el motor de evaluación de SocialLevel, una plataforma donde equipos
resuelven problemas reales en ciclos de 48 horas. Tu única función es evaluar
la calidad de UN aporte de texto, siguiendo una rúbrica fija y objetiva. No
participas en la conversación ni das opiniones — únicamente evalúas.

PASO 1 — Antes de calificar nada, decide si el mensaje es "pertinente": un
intento genuino de aportar al problema planteado. NO es pertinente si es:
ruido sin sentido, spam, un saludo suelto sin contenido, texto aleatorio,
groserías sin argumento, o cualquier cosa que no intente responder al
problema — sin importar qué tan bien escrito esté o cuánto mida.

PASO 2 — Si NO es pertinente: los cinco criterios deben quedar entre 0 y 8,
y "total" no puede superar 5. No le des puntaje "por participar" ni por
claridad — un mensaje irrelevante bien escrito sigue siendo irrelevante.

PASO 3 — Si SÍ es pertinente, evalúa con estos cinco criterios (0-100 cada uno):
- relevancia: ¿responde directamente al problema y a su criterio de éxito?
- originalidad: ¿aporta algo no dicho antes en el hilo?
- traccion: ¿construye sobre un aporte anterior, o es probable que otros construyan sobre él?
- fundamentacion: ¿hay razonamiento, datos o evidencia?
- claridad: ¿se entiende sin esfuerzo excesivo?

Se te dará el peso exacto de cada criterio para la fase actual — calcula "total"
como el promedio ponderado exacto con esos pesos, redondeado al entero más cercano.

Ejemplos de calibración (aplican siempre, sin importar el problema real):
- "jajaja banana asdf" → pertinente:false, todos los criterios 0-3, total 0-2.
- "hola buenos días" (sin ningún contenido sobre el problema) → pertinente:false, total 0-3.
- "no sé, tal vez algo con IA?" → pertinente:true (es un intento real, aunque débil):
  relevancia baja-media, originalidad baja, fundamentación muy baja, total ≈ 15-25.
- Una idea concreta con un dato o ejemplo → pertinente:true, puntajes según la rúbrica normal.

Clasifica el mensaje en un único rol dominante: "generador" (idea nueva,
independiente), "constructor" (mejora o extiende un aporte ajeno), "verificador"
(cuestiona o señala un riesgo con fundamento), o "sintetizador" (resume la
discusión). Si pertinente:false, usa "generador" por defecto (el rol no importa
en ese caso).

Reglas: sé consistente entre evaluaciones similares; no premies la longitud
por sí sola. Responde ÚNICAMENTE llamando a la función solicitada, sin texto
adicional.`;

// Formato OpenAI/DeepSeek de function calling (distinto al de Claude:
// aquí va anidado bajo "function", y el schema usa "parameters" en vez de
// "input_schema").
const TOOL_SCHEMA = {
  type: "function",
  function: {
    name: "evaluar_aporte",
    description: "Evalúa un aporte dentro de un ciclo de la Arena de Problemas de SocialLevel",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        pertinente: { type: "boolean", description: "¿Es un intento genuino de aportar al problema? false = spam, ruido, saludo vacío, texto sin relación" },
        relevancia: { type: "integer", description: "Puntaje 0-100" },
        originalidad: { type: "integer", description: "Puntaje 0-100" },
        traccion: { type: "integer", description: "Puntaje 0-100" },
        fundamentacion: { type: "integer", description: "Puntaje 0-100" },
        claridad: { type: "integer", description: "Puntaje 0-100" },
        total: { type: "integer", description: "Promedio ponderado 0-100" },
        rol: { type: "string", enum: ["generador", "constructor", "verificador", "sintetizador"] },
        justificacion_breve: { type: "string", description: "Máximo 20 palabras" },
      },
      required: ["pertinente", "relevancia", "originalidad", "traccion", "fundamentacion", "claridad", "total", "rol", "justificacion_breve"],
      additionalProperties: false,
    },
  },
};

async function evaluarMensaje({ problema, historial, mensaje, autor, respuestaA, fase }) {
  const pesos = PHASE_WEIGHTS[fase] || PHASE_WEIGHTS.exploracion;
  const bloqueRespuesta = respuestaA ? `\nESTE MENSAJE RESPONDE A:\n"${respuestaA}"\n` : "";

  const userPrompt = `PROBLEMA DEL CICLO:
Título: ${problema.titulo}
Contexto: ${problema.contexto}
Criterio de éxito: ${problema.criterio_exito}

FASE ACTUAL: ${fase}
PESOS DE ESTA FASE: relevancia ${pesos.relevancia}%, originalidad ${pesos.originalidad}%, tracción ${pesos.traccion}%, fundamentación ${pesos.fundamentacion}%, claridad ${pesos.claridad}%

MENSAJES PREVIOS RELEVANTES DEL HILO (máx. 6):
${historial || "(sin mensajes previos en este hilo)"}
${bloqueRespuesta}
MENSAJE A EVALUAR:
Autor: ${autor}
Texto: "${mensaje}"

Evalúa este mensaje siguiendo la rúbrica y los pesos de esta fase.`;

  const response = await client.chat.completions.create({
    model: "deepseek-chat", // enruta a DeepSeek-V4-Flash
    temperature: 0.2,       // baja, para consistencia entre evaluaciones similares
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    tools: [TOOL_SCHEMA],
    tool_choice: { type: "function", function: { name: "evaluar_aporte" } },
  });

  const toolCall = response.choices[0].message.tool_calls?.[0];
  if (!toolCall) throw new Error("DeepSeek no devolvió una evaluación estructurada");
  var result = JSON.parse(toolCall.function.arguments);

  // Salvaguarda de código: no confiamos ciegamente en que el modelo siga la
  // instrucción de "pertinente:false -> puntajes casi cero". Si marcó el
  // mensaje como no pertinente pero igual devolvió puntajes altos, los
  // recortamos aquí — esto no se puede saltar cambiando el prompt.
  if (result.pertinente === false) {
    var cap = 5;
    result.relevancia = Math.min(result.relevancia, cap);
    result.originalidad = Math.min(result.originalidad, cap);
    result.traccion = Math.min(result.traccion, cap);
    result.fundamentacion = Math.min(result.fundamentacion, cap);
    result.claridad = Math.min(result.claridad, cap);
    result.total = Math.min(result.total, cap);
  }

  return result;
}

module.exports = { evaluarMensaje, PHASE_WEIGHTS };

