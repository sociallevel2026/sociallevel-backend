# SocialLevel — Backend (Fase 1 MVP)

API mínima que reemplaza la simulación en memoria del prototipo por datos
reales: usuarios, ciclos, mensajes y evaluación por IA con **DeepSeek**.

> **Nota de decisión:** DeepSeek procesa los datos en servidores en China y no
> ofrece SOC 2 ni DPA/GDPR. Es una opción válida para pruebas, para tu MVP
> interno, o para el Camino C (Comunidades Ancla) del plan de negocio. Si en
> algún momento conectas clientes B2B con datos de negocio reales (Camino B),
> vale la pena revisar esa decisión — el cambio de proveedor solo implica
> tocar `services/evaluar.js`, el resto del backend no cambia.

## Qué incluye

- **Almacenamiento en archivo JSON** (`db/sociallevel.json`, se crea solo al arrancar) — usuarios, ciclos, mensajes, portafolio. Sin dependencias nativas: no necesitas Visual Studio ni ninguna herramienta de compilación, funciona igual en Windows, Mac o Linux.
- **Evaluación real con DeepSeek** (`deepseek-chat` / DeepSeek-V4-Flash), usando exactamente la rúbrica y los pesos por fase que ya definimos (`services/evaluar.js`)
- **Endpoints REST** para crear usuarios, publicar problemas, enviar y evaluar mensajes, cerrar ciclos y consultar el portafolio

## Cómo correrlo

1. Instala las dependencias:
   ```
   npm install
   ```

2. Copia el archivo de configuración y agrega tu clave real de DeepSeek:
   ```
   cp .env.example .env
   ```
   Edita `.env` y reemplaza `sk-tu-clave-de-deepseek-aqui` con tu clave real
   (la consigues en https://platform.deepseek.com).

3. Arranca el servidor:
   ```
   node server.js
   ```
   Deberías ver: `SocialLevel API corriendo en http://localhost:3000`

## Endpoints disponibles

| Método | Ruta | Qué hace |
|---|---|---|
| POST | `/api/users` | Crea un usuario (`name`, `email`) |
| GET | `/api/users/:id` | Perfil del usuario, con su portafolio |
| POST | `/api/cycles` | Publica un nuevo problema/ciclo (`title`, `context`, `success_criteria`) |
| GET | `/api/cycles/active` | Devuelve el ciclo activo actual |
| PATCH | `/api/cycles/:id/phase` | Cambia la fase del ciclo (`phase`: apertura/exploracion/construccion/cierre) |
| POST | `/api/cycles/:id/close` | Cierra el ciclo y genera las entradas de portafolio |
| POST | `/api/messages` | Envía un mensaje — dispara la evaluación real con Claude en segundo plano |
| GET | `/api/messages/:id` | Consulta el resultado de la evaluación (puntajes + rol) |
| GET | `/api/cycles/:id/messages` | Todos los mensajes de un ciclo |

## Probarlo rápido con curl

```bash
# Crear un usuario
curl -X POST http://localhost:3000/api/users \
  -H "Content-Type: application/json" \
  -d '{"name":"Ana Restrepo","email":"ana@test.com"}'

# Publicar un problema
curl -X POST http://localhost:3000/api/cycles \
  -H "Content-Type: application/json" \
  -d '{"title":"Reducir el onboarding de 14 a 5 días","context":"...","success_criteria":"..."}'

# Enviar un mensaje (dispara la evaluación real)
curl -X POST http://localhost:3000/api/messages \
  -H "Content-Type: application/json" \
  -d '{"cycle_id":1,"user_id":1,"text":"Propongo dividir el proceso en 3 bloques paralelos."}'

# Consultar el resultado un par de segundos después
curl http://localhost:3000/api/messages/1
```

## Qué falta para producción real (no incluido todavía, a propósito)

Esto es intencionalmente mínimo — lo justo para validar el piloto, según el
plan de ejecución de 90 días. Lo que sigue después, no antes:

- Autenticación real (por ahora no hay login ni sesiones)
- Migrar del archivo JSON a PostgreSQL cuando haya más de un piloto corriendo a la vez, o más de un usuario editando datos al mismo tiempo (el archivo JSON no soporta escrituras concurrentes de forma segura)
- Desplegar esto en un servidor real (Railway, Render, Fly.io son opciones simples para empezar)
- Conectar el prototipo de frontend (`SocialLevel_Arena_Prototipo.html`) a estos
  endpoints en vez de su simulación local — es el siguiente paso lógico una vez
  confirmes que este backend evalúa bien con datos reales
- Notificaciones push, WebSockets para mensajes en vivo entre varios usuarios reales
