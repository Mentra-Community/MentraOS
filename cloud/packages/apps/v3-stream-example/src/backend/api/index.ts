import { Hono } from "hono";
import stream from "./stream.api";
import state from "./state.api";

const api = new Hono();

api.get("/health", (c) => c.json({ status: "ok" }));
api.route("/stream", stream);
api.route("/state", state);

export { api };
