import { logger } from "../services/logging/pino-logger";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();
const MONGO_URL: string | undefined = process.env.MONGO_URL;
const DEPLOYMENT_REGION: string | undefined = process.env.DEPLOYMENT_REGION;
const IS_CHINA = DEPLOYMENT_REGION === "china";

// Connect to mongo db.
export async function init(): Promise<void> {
  if (!MONGO_URL) throw "MONGO_URL is undefined";
  try {
    mongoose.set("strictQuery", false);
    let modifiedUrl = MONGO_URL;
    if (!IS_CHINA) {
      modifiedUrl = MONGO_URL + "/prod";
    }

    await mongoose.connect(modifiedUrl);
    // After connection
    await mongoose.connection.db.collection("test").insertOne({ test: true });

    logger.info("Mongoose Connected");
  } catch (error) {
    logger.error(`Unable to connect to database(${MONGO_URL}) ${error}`);
    throw error;
  }
}
