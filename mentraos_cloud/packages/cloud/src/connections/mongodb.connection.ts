import { logger } from "@augmentos/utils";
import dotenv from "dotenv";
import mongoose from 'mongoose';

dotenv.config();
const MONGO_URL: string | undefined = process.env.MONGO_URL;
const NODE_ENV: string | undefined = process.env.NODE_ENV;
const IS_PROD = NODE_ENV === 'production';

// Connect to mongo db.
export async function init(): Promise<void> {
  if (!MONGO_URL) throw "MONGO_URL is undefined";
  try {
    mongoose.set('strictQuery', false);
    const database = IS_PROD ? 'prod' : 'dev';

    await mongoose.connect(MONGO_URL + "/prod");
    // After connection
    await mongoose.connection.db.collection('test').insertOne({ test: true });

    logger.info('Mongoose Connected');
  }
  catch (error) {
    logger.error(`Unable to connect to database(${MONGO_URL}) ${error}`);
    throw error;
  }
}