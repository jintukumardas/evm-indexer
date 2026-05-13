import {
  diffPersistedVsFetched,
  identityKey,
} from '../../src/indexer/identity'
import type { EventIdentity } from '../../src/indexer/types'

function id(over: Partial<EventIdentity>): EventIdentity {
  return {
    chainId: 137,
    contractAddress: '0xbd6c7b0d2f68c2b7805d88388319cfb6ecb50ea9',
    blockNumber: 1,
    transactionHash: '0xa',
    logIndex: 0,
    ...over,
  }
}

describe('diffPersistedVsFetched', () => {
  it('returns persisted rows missing from fetched', () => {
    const persisted = [id({ logIndex: 0 }), id({ logIndex: 1 }), id({ logIndex: 2 })]
    const fetched = [id({ logIndex: 0 }), id({ logIndex: 2 })]
    expect(diffPersistedVsFetched(persisted, fetched)).toEqual([id({ logIndex: 1 })])
  })

  it('returns empty when fetched is a superset', () => {
    const persisted = [id({ logIndex: 0 })]
    const fetched = [id({ logIndex: 0 }), id({ logIndex: 1 })]
    expect(diffPersistedVsFetched(persisted, fetched)).toEqual([])
  })

  it('case-normalises contract addresses when computing identity keys', () => {
    const persisted = [id({ contractAddress: '0xABCDEF0000000000000000000000000000000001' })]
    const fetched = [id({ contractAddress: '0xabcdef0000000000000000000000000000000001' })]
    expect(diffPersistedVsFetched(persisted, fetched)).toEqual([])
  })

  it('treats different transactionHashes as different identities (replacement txs)', () => {
    const persisted = [id({ transactionHash: '0xold' })]
    const fetched = [id({ transactionHash: '0xnew' })]
    expect(diffPersistedVsFetched(persisted, fetched)).toEqual([id({ transactionHash: '0xold' })])
  })

  it('identityKey is stable across calls', () => {
    const k1 = identityKey(id({}))
    const k2 = identityKey(id({}))
    expect(k1).toBe(k2)
    expect(identityKey(id({ logIndex: 0 }))).not.toBe(identityKey(id({ logIndex: 1 })))
  })
})
