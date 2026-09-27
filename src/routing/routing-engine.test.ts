import { describe, it, expect, beforeEach, vi } from 'vitest'
import { RoutingEngine, type RoutableAccount } from './routing-engine.js'

describe('RoutingEngine', () => {
  interface TestAccount extends RoutableAccount {
    name: string
  }

  let accounts: TestAccount[]

  beforeEach(() => {
    accounts = [
      { id: 'acc-1', name: 'Account 1', priority: 0, cost: 10, lastUsedAt: 1000 },
      { id: 'acc-2', name: 'Account 2', priority: 1, cost: 5, lastUsedAt: 2000 },
      { id: 'acc-3', name: 'Account 3', priority: 2, cost: 20, lastUsedAt: 500 },
    ]
  })

  it('fill-first selects accounts in priority order', () => {
    const engine = new RoutingEngine<TestAccount>({ strategy: 'fill-first' })
    expect(engine.selectAccount(accounts)?.id).toBe('acc-1')

    // If acc-1 is in cooldown, routes to acc-2
    engine.recordFailure(accounts[0]!, 60000, 1500)
    expect(engine.selectAccount(accounts, 2000)?.id).toBe('acc-2')
  })

  it('round-robin cycles through accounts with sticky limit', () => {
    const engine = new RoutingEngine<TestAccount>({ strategy: 'round-robin', stickyLimit: 2 })

    // Call 1 -> acc-1
    const a1 = engine.selectAccount(accounts)!
    expect(a1.id).toBe('acc-1')
    engine.recordUsage(a1)

    // Call 2 -> acc-1 (sticky limit = 2)
    const a2 = engine.selectAccount(accounts)!
    expect(a2.id).toBe('acc-1')
    engine.recordUsage(a2)

    // Call 3 -> acc-2 (sticky limit reached)
    const a3 = engine.selectAccount(accounts)!
    expect(a3.id).toBe('acc-2')
    engine.recordUsage(a3)

    // Call 4 -> acc-2
    const a4 = engine.selectAccount(accounts)!
    expect(a4.id).toBe('acc-2')
    engine.recordUsage(a4)

    // Call 5 -> acc-3
    const a5 = engine.selectAccount(accounts)!
    expect(a5.id).toBe('acc-3')
  })

  it('p2c selects healthier account or less recently used', () => {
    const engine = new RoutingEngine<TestAccount>({ strategy: 'p2c' })
    accounts[0]!.failureCount = 2
    accounts[1]!.failureCount = 0

    // Force p2c with 2 accounts
    const selected = engine.selectAccount([accounts[0]!, accounts[1]!])
    expect(selected?.id).toBe('acc-2')
  })

  it('random selects an available account', () => {
    const engine = new RoutingEngine<TestAccount>({ strategy: 'random' })
    const selected = engine.selectAccount(accounts)
    expect(selected).toBeDefined()
    expect(['acc-1', 'acc-2', 'acc-3']).toContain(selected?.id)
  })

  it('least-used routes to account with oldest lastUsedAt', () => {
    const engine = new RoutingEngine<TestAccount>({ strategy: 'least-used' })
    // acc-3 has lastUsedAt: 500 (oldest)
    expect(engine.selectAccount(accounts)?.id).toBe('acc-3')

    engine.recordUsage(accounts[2]!, 3000)
    // now acc-1 has lastUsedAt: 1000 (oldest)
    expect(engine.selectAccount(accounts)?.id).toBe('acc-1')
  })

  it('cost-optimized routes to account with lowest cost', () => {
    const engine = new RoutingEngine<TestAccount>({ strategy: 'cost-optimized' })
    // acc-2 has cost: 5
    expect(engine.selectAccount(accounts)?.id).toBe('acc-2')

    // If acc-2 disabled, routes to acc-1 (cost: 10)
    accounts[1]!.disabled = true
    expect(engine.selectAccount(accounts)?.id).toBe('acc-1')
  })

  it('returns null if all accounts are in cooldown or disabled', () => {
    const engine = new RoutingEngine<TestAccount>()
    accounts.forEach((a) => {
      a.disabled = true
    })
    expect(engine.selectAccount(accounts)).toBeNull()
  })
})
