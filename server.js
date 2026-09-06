require("dotenv").config();
const express = require("express");
const cors = require("cors");
const apiRoutes = require("./routes/api");

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ ok: true, service: "SocialLevel API", version: "0.1.0" });
});

app.use("/api", apiRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Error interno del servidor" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SocialLevel API corriendo en http://localhost:${PORT}`);
  if (!process.env.DEEPSEEK_API_KEY) {
    console.warn("⚠️  DEEPSEEK_API_KEY no está configurada — copia .env.example a .env y agrega tu clave.");
  }
});
