// db/index.js — almacenamiento simple en un archivo JSON local.
// Reemplaza a better-sqlite3, que requiere compilar código nativo (node-gyp)
// y en Windows exige tener instalado Visual Studio Build Tools. Para el
// volumen de datos de un piloto (Fase 1), un archivo JSON es más que
// suficiente y funciona igual en cualquier computadora sin instalar nada más.
//
// Antes de un despliegue con más de un puñado de usuarios simultáneos,
// migrar esto a PostgreSQL (ver README) — no es apto para alta concurrencia.
const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "sociallevel.json");

function emptyDB() {
  return { users: [], cycles: [], messages: [], portfolio: [], _seq: {} };
}

function load() {
  if (!fs.existsSync(DB_PATH)) {
    const fresh = emptyDB();
    fs.writeFileSync(DB_PATH, JSON.stringify(fresh, null, 2));
    return fresh;
  }
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch (e) {
    console.error("Base de datos corrupta o vacía, iniciando una nueva.");
    return emptyDB();
  }
}

let db = load();

function save() {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function nextId(collection) {
  db._seq[collection] = (db._seq[collection] || 0) + 1;
  return db._seq[collection];
}

// ---------- API genérica de la "tabla" ----------
function insert(collection, obj) {
  const row = { id: nextId(collection), ...obj };
  db[collection].push(row);
  save();
  return row;
}
function findById(collection, id) {
  return db[collection].find((r) => r.id === Number(id));
}
function find(collection, predicate) {
  return db[collection].filter(predicate);
}
function findOne(collection, predicate) {
  return db[collection].find(predicate);
}
function update(collection, id, patch) {
  const row = findById(collection, id);
  if (!row) return null;
  Object.assign(row, patch);
  save();
  return row;
}
function all(collection) {
  return db[collection];
}
function reload() {
  db = load();
}

module.exports = { insert, findById, find, findOne, update, all, save, reload };
