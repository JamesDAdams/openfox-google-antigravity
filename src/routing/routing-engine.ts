export type RoutingStrategy =
  | 'fill-first'
  | 'round-robin'
  | 'p2c'
  | 'random'
  | 'least-used'
  | 'cost-optimized'

export interface RoutableAccount {
  id: string
  label?: string
  priority?: number
  cost?: number
  disabled?: boolean
  lastUsedAt?: number
  failureCount?: number
  cooldownUntil?: number
}

export interface RoutingEngineOptions {
  strategy?: RoutingStrategy
  stickyLimit?: number
  cooldownMs?: number
}

export class RoutingEngine<T extends RoutableAccount> {
  private strategy: RoutingStrategy
  private stickyLimit: number
  private cooldownMs: number

  private currentStickyAccountId: string | null = null
  private currentStickyUsageCount = 0
  private roundRobinIndex = 0

  constructor(options: RoutingEngineOptions = {}) {
    this.strategy = options.strategy ?? 'fill-first'
    this.stickyLimit = options.stickyLimit ?? 3
    this.cooldownMs = options.cooldownMs ?? 60_000
  }

  setStrategy(strategy: RoutingStrategy): void {
    if (this.strategy !== strategy) {
      this.strategy = strategy
      this.resetSticky()
    }
  }

  getStrategy(): RoutingStrategy {
    return this.strategy
  }

  setStickyLimit(limit: number): void {
    this.stickyLimit = Math.max(1, limit)
  }

  resetSticky(): void {
    this.currentStickyAccountId = null
    this.currentStickyUsageCount = 0
  }

  isAvailable(account: T, now = Date.now()): boolean {
    if (account.disabled) return false
    if (account.cooldownUntil && account.cooldownUntil > now) return false
    return true
  }

  getAvailableAccounts(accounts: T[], now = Date.now()): T[] {
    return accounts.filter((acc) => this.isAvailable(acc, now))
  }

  selectAccount(accounts: T[], now = Date.now()): T | null {
    const available = this.getAvailableAccounts(accounts, now)
    if (available.length === 0) return null
    if (available.length === 1) {
      return available[0] ?? null
    }

    switch (this.strategy) {
      case 'fill-first':
        return this.selectFillFirst(available)
      case 'round-robin':
        return this.selectRoundRobin(available)
      case 'p2c':
        return this.selectP2C(available)
      case 'random':
        return this.selectRandom(available)
      case 'least-used':
        return this.selectLeastUsed(available)
      case 'cost-optimized':
        return this.selectCostOptimized(available)
      default:
        return this.selectFillFirst(available)
    }
  }

  recordUsage(account: T, now = Date.now()): void {
    account.lastUsedAt = now
    if (this.currentStickyAccountId === account.id) {
      this.currentStickyUsageCount++
    } else {
      this.currentStickyAccountId = account.id
      this.currentStickyUsageCount = 1
    }
  }

  recordSuccess(account: T): void {
    account.failureCount = 0
    account.cooldownUntil = undefined
  }

  recordFailure(account: T, customCooldownMs?: number, now = Date.now()): void {
    account.failureCount = (account.failureCount ?? 0) + 1
    const cooldown = customCooldownMs ?? this.cooldownMs * Math.min(account.failureCount, 5)
    account.cooldownUntil = now + cooldown

    if (this.currentStickyAccountId === account.id) {
      this.resetSticky()
    }
  }

  // 1. Fill First: Uses accounts in priority order (lowest priority number = highest precedence, or first in array)
  private selectFillFirst(available: T[]): T {
    const sorted = [...available].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    return sorted[0]!
  }

  // 2. Round Robin: Cycles through accounts with configurable sticky limit
  private selectRoundRobin(available: T[]): T {
    if (
      this.currentStickyAccountId &&
      this.currentStickyUsageCount < this.stickyLimit
    ) {
      const stickyAcc = available.find((a) => a.id === this.currentStickyAccountId)
      if (stickyAcc) return stickyAcc
    }

    this.roundRobinIndex = this.roundRobinIndex % available.length
    const selected = available[this.roundRobinIndex]!
    this.roundRobinIndex = (this.roundRobinIndex + 1) % available.length

    this.currentStickyAccountId = selected.id
    this.currentStickyUsageCount = 0
    return selected
  }

  // 3. P2C (Power of Two Choices): Picks 2 random accounts and routes to the healthier one
  private selectP2C(available: T[]): T {
    if (available.length === 2) {
      return this.compareHealth(available[0]!, available[1]!)
    }
    const idx1 = Math.floor(Math.random() * available.length)
    let idx2 = Math.floor(Math.random() * available.length)
    while (idx2 === idx1) {
      idx2 = Math.floor(Math.random() * available.length)
    }

    const acc1 = available[idx1]!
    const acc2 = available[idx2]!
    return this.compareHealth(acc1, acc2)
  }

  private compareHealth(a: T, b: T): T {
    const failA = a.failureCount ?? 0
    const failB = b.failureCount ?? 0
    if (failA !== failB) {
      return failA < failB ? a : b
    }
    const lastA = a.lastUsedAt ?? 0
    const lastB = b.lastUsedAt ?? 0
    return lastA <= lastB ? a : b
  }

  // 4. Random: Randomly selects an account using Fisher-Yates shuffle
  private selectRandom(available: T[]): T {
    const pool = [...available]
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const temp = pool[i]!
      pool[i] = pool[j]!
      pool[j] = temp
    }
    return pool[0]!
  }

  // 5. Least Used: Routes to account with oldest lastUsedAt timestamp
  private selectLeastUsed(available: T[]): T {
    const sorted = [...available].sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0))
    return sorted[0]!
  }

  // 6. Cost Optimized: Routes to account with lowest cost (or lowest priority value)
  private selectCostOptimized(available: T[]): T {
    const sorted = [...available].sort((a, b) => {
      const costA = a.cost ?? a.priority ?? 0
      const costB = b.cost ?? b.priority ?? 0
      return costA - costB
    })
    return sorted[0]!
  }
}
