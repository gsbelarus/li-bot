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

export class DatabaseConnectionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "DatabaseConnectionError";

    if (options && "cause" in options) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

if (!global.mongooseCache) {
  global.mongooseCache = { conn: null, promise: null };
}

export async function connectToDatabase() {
  if (!MONGODB_URI) {
    throw new DatabaseConnectionError("MongoDB is not configured: missing MONGODB_URI.");
  }

  if (!MONGODB_DB) {
    throw new DatabaseConnectionError("MongoDB is not configured: missing MONGODB_DB.");
  }

  const cached = global.mongooseCache;

  if (!cached) {
    throw new DatabaseConnectionError("MongoDB cache initialization failed.");
  }

  if (cached.conn) {
    return cached.conn;
  }

  if (!cached.promise) {
    cached.promise = mongoose
      .connect(MONGODB_URI, {
        dbName: MONGODB_DB,
        bufferCommands: false,
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 5000,
      })
      .catch((error: unknown) => {
        cached.promise = null;
        cached.conn = null;

        console.error("MongoDB connection failed", error);

        throw new DatabaseConnectionError(
          "Unable to reach MongoDB. Check network access, DNS resolution, and the configured cluster address.",
          { cause: error }
        );
      });
  }

  cached.conn = await cached.promise;
  return cached.conn;
}
