import { AggregateService, clampAggregateLimit } from '../../src/services/aggregates/aggregateService'
import { ValidationError } from '../../src/app/errors'

describe('clampAggregateLimit', () => {
  it('defaults to 365 when input is missing or NaN', () => {
    expect(clampAggregateLimit(undefined)).toBe(365)
    expect(clampAggregateLimit(Number.NaN)).toBe(365)
  })
  it('clamps to [1, 1000]', () => {
    expect(clampAggregateLimit(0)).toBe(1)
    expect(clampAggregateLimit(-50)).toBe(1)
    expect(clampAggregateLimit(100_000)).toBe(1000)
  })
})

describe('AggregateService.list validation', () => {
  // Repo is unused for these paths — Service rejects before touching it.
  const fakeRepo = {
    rebuildFromFeeEvents: jest.fn(),
    listByIntegrator: jest.fn().mockResolvedValue([]),
  } as unknown as ConstructorParameters<typeof AggregateService>[0]
  const service = new AggregateService(fakeRepo)

  it('rejects bad integrator addresses', async () => {
    await expect(service.list({ integrator: 'not-an-address' })).rejects.toBeInstanceOf(
      ValidationError,
    )
  })

  it('rejects bad token addresses', async () => {
    await expect(
      service.list({
        integrator: '0x' + 'd'.repeat(40),
        token: 'not-a-token',
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects bad day strings', async () => {
    await expect(
      service.list({ integrator: '0x' + 'd'.repeat(40), fromDay: '2024/01/01' }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('passes through validated parameters', async () => {
    await service.list({
      integrator: '0x' + 'd'.repeat(40),
      token: '0x' + 'a'.repeat(40),
      fromDay: '2024-01-01',
      toDay: '2024-12-31',
      chainId: 137,
    })
    expect(
      (fakeRepo.listByIntegrator as jest.Mock).mock.calls.at(-1)![0],
    ).toMatchObject({
      integrator: '0x' + 'd'.repeat(40),
      token: '0x' + 'a'.repeat(40),
      fromDay: '2024-01-01',
      toDay: '2024-12-31',
      chainId: 137,
    })
  })
})

describe('AggregateService.rebuild', () => {
  it('skips when fromBlock > toBlock', async () => {
    const rebuild = jest.fn()
    const service = new AggregateService({
      rebuildFromFeeEvents: rebuild,
      listByIntegrator: jest.fn(),
    } as unknown as ConstructorParameters<typeof AggregateService>[0])
    await service.rebuild(137, 100, 50)
    expect(rebuild).not.toHaveBeenCalled()
  })

  it('delegates to the repository for valid ranges', async () => {
    const rebuild = jest.fn().mockResolvedValue(undefined)
    const service = new AggregateService({
      rebuildFromFeeEvents: rebuild,
      listByIntegrator: jest.fn(),
    } as unknown as ConstructorParameters<typeof AggregateService>[0])
    await service.rebuild(137, 1, 100)
    expect(rebuild).toHaveBeenCalledWith(137, 1, 100)
  })
})
