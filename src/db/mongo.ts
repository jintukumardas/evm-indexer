import mongoose from 'mongoose'
import { DatabaseError } from '../app/errors'
import { getLogger } from '../app/logging'

let connection: typeof mongoose | null = null

export interface MongoConnectOptions {
  uri: string
  /** When true, do not retry — used by short-lived scripts and tests. */
  failFast?: boolean
}

/**
 * Connects to MongoDB with sensible production defaults. Returns the same
 * connection on repeat calls so the rest of the app can ignore the lifecycle.
 */
export async function connectMongo(opts: MongoConnectOptions): Promise<typeof mongoose> {
  if (connection && mongoose.connection.readyState === 1) return connection
  const log = getLogger()
  try {
    log.info({ uri: redactUri(opts.uri) }, 'Connecting to MongoDB')
    connection = await mongoose.connect(opts.uri, {
      serverSelectionTimeoutMS: opts.failFast ? 5_000 : 15_000,
      maxPoolSize: 20,
    })
    log.info('MongoDB connected')
    return connection
  } catch (err) {
    throw new DatabaseError(`Failed to connect to MongoDB: ${(err as Error).message}`, err)
  }
}

export async function disconnectMongo(): Promise<void> {
  if (!connection) return
  await mongoose.disconnect()
  connection = null
}

/** Strip credentials from `mongodb://user:pass@host/db` for safe logging. */
function redactUri(uri: string): string {
  return uri.replace(/\/\/([^@]+)@/, '//***@')
}
