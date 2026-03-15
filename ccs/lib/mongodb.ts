import mongoose from "mongoose";

declare global {
  var mongooseCache:
    | {
      conn: typeof mongoose | null;
      promise: Promise<typeof mongoose> | null;
    }
    | undefined;
}

const { MONGODB_URI, MONGODB_DB } = process.env;

if (!global.mongooseCache) {
  global.mongooseCache = { conn: null, promise: null };
}

export async function connectToDatabase() {
  if (!MONGODB_URI) {
    throw new Error("Missing MONGODB_URI environment variable.");
  }

  if (!MONGODB_DB) {
    throw new Error("Missing MONGODB_DB environment variable.");
  }

  const cached = global.mongooseCache;

  if (!cached) {
    throw new Error("Mongo cache initialization failed.");
  }

  if (cached.conn) {
    return cached.conn;
  }

  if (!cached.promise) {
    cached.promise = mongoose.connect(MONGODB_URI, {
      dbName: MONGODB_DB,
      bufferCommands: false,
      maxPoolSize: 10,
    });
  }

  cached.conn = await cached.promise;
  return cached.conn;
}
