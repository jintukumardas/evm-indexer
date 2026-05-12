import { ValidationError } from '../../app/errors'
import {
  AggregateRepository,
  type ListAggregatesOpts,
} from '../../db/repositories/aggregateRepository'
import type { DailyAggregate } from '../../db/models/DailyAggregate'

export interface ListAggregatesParams {
  integrator: string
  chainId?: number
  token?: string
  fromDay?: string
  toDay?: string
  limit?: number
}

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Application service for aggregate queries. Wraps the repository with
 * input validation (addresses + ISO dates) and rebuild orchestration.
 */
export class AggregateService {
  constructor(private readonly repo: AggregateRepository) {}

  /**
   * Per-chain serialization of rebuilds. The repository's two-step pipeline
   * (discover affected days → re-aggregate those days with `$merge replace`)
   * is only correct under sequential execution. If two rebuilds for the same
   * chain interleave, the later writer can overwrite the earlier writer with
   * a snapshot that pre-dates the earlier writer's new events.
   *
   * The lock is in-process. A single indexer worker per chain — the deployed
   * topology — means this is sufficient. If you ever run multiple workers per
   * chain, replace with an advisory lock in `SyncState`.
   */
  private rebuildChain = new Map<number, Promise<void>>()

  async rebuild(chainId: number, fromBlock: number, toBlock: number): Promise<void> {
    if (fromBlock > toBlock) return
    const prev = this.rebuildChain.get(chainId) ?? Promise.resolve()
    const next = prev
      .catch(() => undefined)
      .then(() => this.repo.rebuildFromFeeEvents(chainId, fromBlock, toBlock))
    this.rebuildChain.set(chainId, next)
    try {
      await next
    } finally {
      if (this.rebuildChain.get(chainId) === next) this.rebuildChain.delete(chainId)
    }
  }

  async list(params: ListAggregatesParams): Promise<DailyAggregate[]> {
    if (!ADDRESS_RE.test(params.integrator)) {
      throw new ValidationError('integrator must be a 0x-prefixed 20-byte hex address')
    }
    if (params.token && !ADDRESS_RE.test(params.token)) {
      throw new ValidationError('token must be a 0x-prefixed 20-byte hex address')
    }
    if (params.fromDay && !DAY_RE.test(params.fromDay)) {
      throw new ValidationError('fromDay must be YYYY-MM-DD')
    }
    if (params.toDay && !DAY_RE.test(params.toDay)) {
      throw new ValidationError('toDay must be YYYY-MM-DD')
    }
    const limit = clampAggregateLimit(params.limit)
    const repoArgs: ListAggregatesOpts = {
      integrator: params.integrator,
      limit,
      chainId: params.chainId,
      token: params.token,
      fromDay: params.fromDay,
      toDay: params.toDay,
    }
    return this.repo.listByIntegrator(repoArgs)
  }
}

export function clampAggregateLimit(input: number | undefined): number {
  if (input == null || Number.isNaN(input)) return 365
  const n = Math.floor(input)
  if (n < 1) return 1
  if (n > 1000) return 1000
  return n
}
