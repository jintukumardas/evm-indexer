import { BigNumber, ethers } from 'ethers'
import {
  getFeeCollectorInterface,
  FEE_COLLECTOR_ABI,
} from '../../src/blockchain/contracts/feeCollector'
import { parseFeeCollectorEvents } from '../../src/blockchain/parsers/feeCollectorParser'

/**
 * Helpers to synthesize a realistic ethers.Event by encoding the topics/data
 * the way a node would emit them, then letting our parser do the round-trip.
 */
function makeFeesCollectedEvent(args: {
  token: string
  integrator: string
  integratorFee: string | number
  lifiFee: string | number
  blockNumber?: number
  transactionHash?: string
  logIndex?: number
  blockHash?: string
  removed?: boolean
}): ethers.Event {
  const iface = getFeeCollectorInterface()
  const fragment = iface.getEvent('FeesCollected')
  const topic0 = iface.getEventTopic(fragment)
  const topicToken = ethers.utils.hexZeroPad(args.token, 32)
  const topicIntegrator = ethers.utils.hexZeroPad(args.integrator, 32)
  const data = ethers.utils.defaultAbiCoder.encode(
    ['uint256', 'uint256'],
    [BigNumber.from(args.integratorFee), BigNumber.from(args.lifiFee)],
  )
  return {
    blockNumber: args.blockNumber ?? 1_000,
    blockHash: args.blockHash ?? '0x' + 'b'.repeat(64),
    transactionIndex: 0,
    removed: args.removed ?? false,
    address: '0xbD6C7B0d2f68c2b7805d88388319cfB6EcB50eA9',
    data,
    topics: [topic0, topicToken, topicIntegrator],
    transactionHash: args.transactionHash ?? '0x' + 'a'.repeat(64),
    logIndex: args.logIndex ?? 0,
    event: 'FeesCollected',
    eventSignature: 'FeesCollected(address,address,uint256,uint256)',
    args: [] as never,
    getBlock: jest.fn() as never,
    getTransaction: jest.fn() as never,
    getTransactionReceipt: jest.fn() as never,
    decode: jest.fn() as never,
    removeListener: jest.fn() as never,
  } as unknown as ethers.Event
}

describe('parseFeeCollectorEvents', () => {
  const ctx = {
    chainId: 137,
    chainKey: 'polygon',
    contractAddress: '0xbD6C7B0d2f68c2b7805d88388319cfB6EcB50eA9',
    blockTimestamps: new Map<number, number>([
      [1, 1_700_000_000],
      [1_000, 1_700_000_100],
      [78_600_100, 1_700_000_200],
    ]),
  }

  it('parses a well-formed event with addresses lowercased and fees as strings', () => {
    const event = makeFeesCollectedEvent({
      token: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      integrator: '0x000000000000000000000000000000000000dEaD',
      integratorFee: '1000000000000000000', // 1e18
      lifiFee: '500000000000000000', // 5e17
      blockNumber: 78600100,
      logIndex: 7,
      transactionHash: '0xtx',
    })
    const out = parseFeeCollectorEvents([event], ctx)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      chainId: 137,
      chainKey: 'polygon',
      contractAddress: '0xbd6c7b0d2f68c2b7805d88388319cfb6ecb50ea9',
      token: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
      integrator: '0x000000000000000000000000000000000000dead',
      integratorFee: '1000000000000000000',
      lifiFee: '500000000000000000',
      blockNumber: 78600100,
      blockTimestamp: 1_700_000_200,
      logIndex: 7,
      transactionHash: '0xtx',
      removed: false,
      eventName: 'FeesCollected',
    })
  })

  it('skips events whose block has no fetched timestamp', () => {
    const event = makeFeesCollectedEvent({
      token: '0x0000000000000000000000000000000000000001',
      integrator: '0x0000000000000000000000000000000000000002',
      integratorFee: '1',
      lifiFee: '1',
      blockNumber: 9_999_999, // not in ctx.blockTimestamps
    })
    expect(parseFeeCollectorEvents([event], ctx)).toEqual([])
  })

  it('preserves full uint256 precision (values larger than 2^53)', () => {
    const huge = '115792089237316195423570985008687907853269984665640564039457584007913129639935' // 2^256 - 1
    const event = makeFeesCollectedEvent({
      token: '0x0000000000000000000000000000000000000001',
      integrator: '0x0000000000000000000000000000000000000002',
      integratorFee: huge,
      lifiFee: '12345678901234567890',
    })
    const [row] = parseFeeCollectorEvents([event], ctx)
    expect(row.integratorFee).toBe(huge)
    expect(row.lifiFee).toBe('12345678901234567890')
  })

  it('skips logs that do not match the FeesCollected ABI', () => {
    const bogus = {
      blockNumber: 1,
      blockHash: '0x' + 'b'.repeat(64),
      transactionHash: '0x' + 'a'.repeat(64),
      logIndex: 0,
      removed: false,
      address: '0x0',
      data: '0x',
      topics: ['0xdeadbeef'],
    } as unknown as ethers.Event
    expect(parseFeeCollectorEvents([bogus], ctx)).toEqual([])
  })

  it('flags `removed` when the underlying log was reorged out', () => {
    const event = makeFeesCollectedEvent({
      token: '0x0000000000000000000000000000000000000001',
      integrator: '0x0000000000000000000000000000000000000002',
      integratorFee: '0',
      lifiFee: '0',
      removed: true,
    })
    const [row] = parseFeeCollectorEvents([event], ctx)
    expect(row.removed).toBe(true)
  })

  it('contract ABI exposes exactly the FeesCollected event', () => {
    expect(FEE_COLLECTOR_ABI.map((a) => a.name)).toEqual(['FeesCollected'])
  })
})
