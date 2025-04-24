import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import authRoutes from "./routes/auth.routes";

dotenv.config();
const app = express();
app.use(cors(), express.json());

app.get("/hello", (_req, res) => {
  res.json({ message: "Hello from Bun + Express!" });
});

app.use("/api", authRoutes);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () =>
  console.log(`🚀 Server running on http://localhost:${PORT}`)
);
