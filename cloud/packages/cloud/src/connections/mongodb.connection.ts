import { logger as rootLogger } from "../services/logging/pino-logger";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();
const MONGO_URL: string | undefined = process.env.MONGO_URL;
const DEPLOYMENT_REGION: string | undefined = process.env.DEPLOYMENT_REGION;
const IS_CHINA = DEPLOYMENT_REGION === "china";
const SLOW_QUERY_MS = parseInt(process.env.MONGOOSE_SLOW_QUERY_MS || "0", 10);

const logger = rootLogger.child({ service: "mongodb" });

// Mongoose plugin that wraps query execution with timing.
// Logs a warning through Pino (→ BetterStack) for queries exceeding the threshold.
function slowQueryPlugin(schema: mongoose.Schema): void {
  if (SLOW_QUERY_MS <= 0) return;

  schema.pre(
    /^(find|findOne|findOneAndUpdate|findOneAndDelete|countDocuments|aggregate|updateOne|updateMany|deleteOne|deleteMany)/,
    function (this: any) {
      this._queryStartTime = performance.now();
    },
  );

  schema.post(
    /^(find|findOne|findOneAndUpdate|findOneAndDelete|countDocuments|aggregate|updateOne|updateMany|deleteOne|deleteMany)/,
    function (this: any) {
      if (!this._queryStartTime) return;
      const durationMs = performance.now() - this._queryStartTime;
      if (durationMs > SLOW_QUERY_MS) {
        const collection = this.mongooseCollection?.name || this.model?.collection?.name || "unknown";
        const operation = this.op || "unknown";
        logger.warn(
          {
            feature: "slow-query",
            collection,
            operation,
            durationMs: Math.round(durationMs * 10) / 10,
          },
          `Slow MongoDB query: ${collection}.${operation} ${Math.round(durationMs)}ms`,
        );
      }
    },
  );
}

// Connect to mongo db.
export async function init(): Promise<void> {
  if (!MONGO_URL) throw "MONGO_URL is undefined";
  try {
    mongoose.set("strictQuery", false);

    // Register slow query plugin globally before connecting
    if (SLOW_QUERY_MS > 0) {
      mongoose.plugin(slowQueryPlugin);
      logger.info({ thresholdMs: SLOW_QUERY_MS }, "Slow query monitoring enabled");
    }
    let modifiedUrl = MONGO_URL;
    if (!IS_CHINA) {
      modifiedUrl = MONGO_URL + "/prod";
    }

    await mongoose.connect(modifiedUrl);
    // After connection
    await mongoose.connection.db.collection("test").insertOne({ test: true });

    logger.info({ slowQueryThresholdMs: SLOW_QUERY_MS || "disabled" }, "Mongoose Connected");
  } catch (error) {
    logger.error(`Unable to connect to database(${MONGO_URL}) ${error}`);
    throw error;
  }
}
