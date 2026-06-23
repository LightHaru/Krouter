import { describe, expect, it } from 'vitest'
import { RegistrationCircuitBreaker } from '../../src/renderer/src/lib/registrationCircuitBreaker'

describe('RegistrationCircuitBreaker', () => {
  it('stops after repeated proxy preflight failures and resets after a healthy route', () => {
    const guard = new RegistrationCircuitBreaker({ maxConsecutiveNetworkFailures: 3 })

    expect(guard.record('network_route_failed').stop).toBe(false)
    expect(guard.record('network_route_ok').consecutiveNetworkFailures).toBe(0)
    expect(guard.record('network_route_failed').stop).toBe(false)
    expect(guard.record('network_route_failed').stop).toBe(false)

    const decision = guard.record('network_route_failed')
    expect(decision.stop).toBe(true)
    expect(decision.reason).toContain('3 consecutive proxy routes')
  })

  it('stops after repeated service rejections and clears the streak on success', () => {
    const guard = new RegistrationCircuitBreaker({ maxConsecutiveServiceRejections: 3 })

    expect(guard.record('service_rejected').stop).toBe(false)
    expect(guard.record('registration_ok').consecutiveServiceRejections).toBe(0)
    expect(guard.record('service_rejected').stop).toBe(false)
    expect(guard.record('service_rejected').stop).toBe(false)

    const decision = guard.record('service_rejected')
    expect(decision.stop).toBe(true)
    expect(decision.reason).toContain('3 consecutive registration requests')
  })

  it('does not clear proxy gateway failures when only the IP preflight succeeds', () => {
    const guard = new RegistrationCircuitBreaker({ maxConsecutiveProxyGatewayFailures: 3 })

    expect(guard.record('proxy_gateway_rejected').stop).toBe(false)
    guard.record('network_route_ok')
    expect(guard.record('proxy_gateway_rejected').stop).toBe(false)
    guard.record('network_route_ok')

    const decision = guard.record('proxy_gateway_rejected')
    expect(decision.stop).toBe(true)
    expect(decision.consecutiveProxyGatewayFailures).toBe(3)
    expect(decision.reason).toContain('proxy gateways returned HTML 403')
  })

  it('stops immediately for risk control and suspended accounts', () => {
    expect(new RegistrationCircuitBreaker().record('risk_control').stop).toBe(true)
    expect(new RegistrationCircuitBreaker().record('account_suspended').stop).toBe(true)
  })
})
