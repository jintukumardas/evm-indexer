import { BigNumber, ethers } from 'ethers'
import { getFeeCollectorInterface, FEES_COLLECTED_EVENT } from '../contracts/feeCollector'
import type { NormalizedFeeEvent } from '../../types'

export interface ParseContext {
  chainId: number
  chainKey: string
  contractAddress: string
  /**
   * Map of `blockNumber → unix seconds` covering every block in the event
   * batch. Required so that each row carries the chain's own timestamp for
   * daily-aggregate bucketing; callers fetch the block headers once per
   * unique block.
   */
  blockTimestamps: ReadonlyMap<number, number>
}

/**
 * Parses raw `ethers.Event` logs into normalized `NormalizedFeeEvent` rows.
 *
 * Addresses are lowercased on write so the unique key and lookups are case-stable.
 * `lifi-contract-types` stores addresses checksummed; we don't rely on that here.
 *
 * Fee values are kept as decimal strings — JS `number` would silently truncate
 * uint256 values larger than 2^53.
 *
 * Unparseable logs (wrong topic, ABI mismatch) are skipped rather than crashing
 * the chunk; we log a warning at the call site. Logs whose `blockNumber` is
 * not present in `blockTimestamps` are also skipped — a missing timestamp
 * indicates the caller did not fetch the header for that block, which would
 * silently produce mis-bucketed aggregates downstream.
 */
export function parseFeeCollectorEvents(
  events: ethers.Event[],
  ctx: ParseContext,
): NormalizedFeeEvent[] {
  const iface = getFeeCollectorInterface()
  const out: NormalizedFeeEvent[] = []

  for (const event of events) {
    let parsed: ethers.utils.LogDescription
    try {
      parsed = iface.parseLog(event)
    } catch {
      // Not a FeesCollected log (or ABI mismatch). Skip — caller logs the count.
      continue
    }
    if (parsed.name !== FEES_COLLECTED_EVENT) continue

    const blockTimestamp = ctx.blockTimestamps.get(event.blockNumber)
    if (blockTimestamp == null) continue

    const token = String(parsed.args._token ?? parsed.args[0]).toLowerCase()
    const integrator = String(parsed.args._integrator ?? parsed.args[1]).toLowerCase()
    const integratorFee = BigNumber.from(parsed.args._integratorFee ?? parsed.args[2]).toString()
    const lifiFee = BigNumber.from(parsed.args._lifiFee ?? parsed.args[3]).toString()

    out.push({
      chainId: ctx.chainId,
      chainKey: ctx.chainKey,
      contractAddress: ctx.contractAddress.toLowerCase(),
      blockNumber: event.blockNumber,
      blockHash: event.blockHash,
      blockTimestamp,
      transactionHash: event.transactionHash,
      logIndex: event.logIndex,
      token,
      integrator,
      integratorFee,
      lifiFee,
      removed: Boolean(event.removed),
      eventName: FEES_COLLECTED_EVENT,
    })
  }
  return out
}
