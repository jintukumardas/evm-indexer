import { IndexerRegistry } from '../../src/indexer/registry'
import type { ContractEventPlugin } from '../../src/indexer/types'
import { ConfigError } from '../../src/app/errors'

function stubPlugin(key: string, chainKey = 'polygon'): ContractEventPlugin {
  return {
    key,
    chainKey,
    chainId: 137,
    contractAddress: '0xaaaa',
    eventName: 'X',
    startBlock: 0,
    metricsLabels: { chain: chainKey, plugin: key },
    getInterface: jest.fn(),
    buildFilter: jest.fn(),
    parse: jest.fn().mockReturnValue([]),
    identityOf: jest.fn(),
    persistChunk: jest.fn(),
    findInRange: jest.fn(),
    markRemoved: jest.fn(),
    restoreRemoved: jest.fn(),
  } as unknown as ContractEventPlugin
}

describe('IndexerRegistry', () => {
  it('registers a plugin and exposes it via list / get / has', () => {
    const r = new IndexerRegistry()
    const p = stubPlugin('a')
    r.register(p)
    expect(r.size()).toBe(1)
    expect(r.list()).toEqual([p])
    expect(r.get('a')).toBe(p)
    expect(r.has('a')).toBe(true)
    expect(r.get('missing')).toBeUndefined()
    expect(r.has('missing')).toBe(false)
  })

  it('throws a ConfigError on duplicate plugin keys', () => {
    const r = new IndexerRegistry()
    r.register(stubPlugin('dup'))
    expect(() => r.register(stubPlugin('dup'))).toThrow(ConfigError)
  })

  it('filters by chainKey via forChain()', () => {
    const r = new IndexerRegistry()
    const a = stubPlugin('polygon:a', 'polygon')
    const b = stubPlugin('polygon:b', 'polygon')
    const c = stubPlugin('ethereum:a', 'ethereum')
    r.register(a)
    r.register(b)
    r.register(c)
    expect(r.forChain('polygon')).toEqual([a, b])
    expect(r.forChain('ethereum')).toEqual([c])
    expect(r.forChain('arbitrum')).toEqual([])
  })

  it('preserves insertion order in list()', () => {
    const r = new IndexerRegistry()
    const a = stubPlugin('1')
    const b = stubPlugin('2')
    const c = stubPlugin('3')
    r.register(a)
    r.register(b)
    r.register(c)
    expect(r.list().map((p) => p.key)).toEqual(['1', '2', '3'])
  })
})
