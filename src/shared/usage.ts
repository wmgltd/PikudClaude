/**
 * Shape of the ccusage "active block" reading.
 *
 * Kept here because the preload bridge had its own narrower copy that omitted
 * costPerHour / tokensPerMinute / projectedCost / projectedTokens, so the value
 * main actually sends did not satisfy the type the Sidebar consumed.
 */
export interface ActiveUsageBlock {
  startTime: string
  endTime: string
  totalTokens: number
  costUSD: number
  msUntilReset: number
  percentUsed: number | null
  costPerHour: number | null
  tokensPerMinute: number | null
  projectedCost: number | null
  projectedTokens: number | null
}
