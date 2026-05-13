import mongoose from 'mongoose'
import request from 'supertest'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { buildApp } from '../../src/api/app'

let mongoServer: MongoMemoryServer
const app = buildApp()

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create()
  await mongoose.connect(mongoServer.getUri())
})
afterAll(async () => {
  await mongoose.disconnect()
  await mongoServer.stop()
})

describe('OpenAPI surface', () => {
  it('serves the spec at /openapi.json', async () => {
    const res = await request(app).get('/openapi.json')
    expect(res.status).toBe(200)
    expect(res.body.openapi).toBe('3.0.3')
    expect(res.body.paths['/fee-events']).toBeDefined()
    expect(res.body.paths['/fee-events/aggregates']).toBeDefined()
  })

  it('serves swagger UI at /docs/', async () => {
    const res = await request(app).get('/docs/')
    expect(res.status).toBe(200)
    expect(res.text).toContain('swagger-ui')
  })

  it('exposes Prometheus metrics at /metrics', async () => {
    // Hit a route so the http counter has data.
    await request(app).get('/health')
    const res = await request(app).get('/metrics')
    expect(res.status).toBe(200)
    expect(res.text).toContain('http_requests_total')
    expect(res.text).toContain('indexer_events_inserted_total')
  })
})
