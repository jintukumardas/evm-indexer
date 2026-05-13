/**
 * OpenAPI 3.0 spec for the API surface. Kept inline (TS object) instead of a
 * YAML file so we don't need a YAML parser at runtime. Edit and the `/docs`
 * UI + `/openapi.json` update on the next process boot.
 */
export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'LI.FI FeeCollector Indexer API',
    version: '0.1.0',
    description:
      'Read-only API over the indexed FeesCollected events. Cursor-paginated event listings and pre-rolled daily aggregates.',
  },
  servers: [{ url: '/', description: 'this server' }],
  paths: {
    '/health': {
      get: {
        summary: 'Liveness probe',
        responses: {
          '200': {
            description: 'Service is healthy',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Health' },
              },
            },
          },
          '503': {
            description: 'Service is degraded (e.g. Mongo not connected)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Health' } } },
          },
        },
      },
    },
    '/metrics': {
      get: {
        summary: 'Prometheus metrics scrape endpoint',
        responses: {
          '200': {
            description: 'OpenMetrics-formatted metrics',
            content: { 'text/plain': { schema: { type: 'string' } } },
          },
        },
      },
    },
    '/fee-events': {
      get: {
        summary: 'List FeesCollected events for an integrator',
        parameters: [
          {
            name: 'integrator',
            in: 'query',
            required: true,
            schema: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' },
            description: '0x-prefixed 20-byte integrator address',
          },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
          },
          {
            name: 'cursor',
            in: 'query',
            schema: { type: 'string' },
            description: 'Opaque cursor returned by a previous response',
          },
          {
            name: 'chainId',
            in: 'query',
            schema: { type: 'integer', minimum: 1 },
          },
        ],
        responses: {
          '200': {
            description: 'A page of fee events newest-first',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['data', 'pageInfo'],
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/FeeEvent' } },
                    pageInfo: { $ref: '#/components/schemas/PageInfo' },
                  },
                },
              },
            },
          },
          '400': {
            description: 'Invalid input',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorBody' } } },
          },
        },
      },
    },
    '/fee-events/aggregates': {
      get: {
        summary: 'Daily fee aggregates per integrator + token + day',
        parameters: [
          {
            name: 'integrator',
            in: 'query',
            required: true,
            schema: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' },
          },
          {
            name: 'token',
            in: 'query',
            schema: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' },
          },
          { name: 'chainId', in: 'query', schema: { type: 'integer', minimum: 1 } },
          {
            name: 'fromDay',
            in: 'query',
            schema: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          },
          {
            name: 'toDay',
            in: 'query',
            schema: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 1000, default: 365 },
          },
        ],
        responses: {
          '200': {
            description: 'Aggregates ordered by day desc, token asc',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['data'],
                  properties: {
                    data: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/DailyAggregate' },
                    },
                  },
                },
              },
            },
          },
          '400': {
            description: 'Invalid input',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorBody' } } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Health: {
        type: 'object',
        required: ['status', 'db'],
        properties: {
          status: { type: 'string', enum: ['ok', 'degraded'] },
          db: { type: 'string' },
        },
      },
      FeeEvent: {
        type: 'object',
        required: [
          'chainId',
          'chainKey',
          'contractAddress',
          'blockNumber',
          'blockHash',
          'blockTimestamp',
          'transactionHash',
          'logIndex',
          'token',
          'integrator',
          'integratorFee',
          'lifiFee',
          'removed',
          'eventName',
        ],
        properties: {
          chainId: { type: 'integer' },
          chainKey: { type: 'string' },
          contractAddress: { type: 'string' },
          blockNumber: { type: 'integer' },
          blockHash: { type: 'string' },
          blockTimestamp: {
            type: 'integer',
            description: 'Unix seconds from the block header',
          },
          transactionHash: { type: 'string' },
          logIndex: { type: 'integer' },
          token: { type: 'string' },
          integrator: { type: 'string' },
          integratorFee: { type: 'string', description: 'decimal uint256 as string' },
          lifiFee: { type: 'string', description: 'decimal uint256 as string' },
          removed: { type: 'boolean' },
          eventName: { type: 'string' },
          processedAt: { type: 'string', format: 'date-time' },
        },
      },
      DailyAggregate: {
        type: 'object',
        required: [
          'chainId',
          'integrator',
          'token',
          'day',
          'integratorFeeSum',
          'lifiFeeSum',
          'eventCount',
        ],
        properties: {
          chainId: { type: 'integer' },
          integrator: { type: 'string' },
          token: { type: 'string' },
          day: { type: 'string', description: 'ISO date YYYY-MM-DD (UTC)' },
          integratorFeeSum: { type: 'string', description: 'decimal sum as string' },
          lifiFeeSum: { type: 'string', description: 'decimal sum as string' },
          eventCount: { type: 'integer' },
        },
      },
      PageInfo: {
        type: 'object',
        required: ['hasNextPage', 'nextCursor'],
        properties: {
          hasNextPage: { type: 'boolean' },
          nextCursor: { type: 'string', nullable: true },
        },
      },
      ErrorBody: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
  },
} as const
