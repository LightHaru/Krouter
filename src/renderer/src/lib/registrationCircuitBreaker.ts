export type RegistrationCircuitEvent =
  | 'network_route_failed'
  | 'network_route_ok'
  | 'proxy_gateway_rejected'
  | 'service_rejected'
  | 'registration_ok'
  | 'risk_control'
  | 'account_suspended'

export interface RegistrationCircuitDecision {
  stop: boolean
  reason?: string
  consecutiveNetworkFailures: number
  consecutiveProxyGatewayFailures: number
  consecutiveServiceRejections: number
}

export interface RegistrationCircuitOptions {
  maxConsecutiveNetworkFailures?: number
  maxConsecutiveProxyGatewayFailures?: number
  maxConsecutiveServiceRejections?: number
}

export class RegistrationCircuitBreaker {
  private consecutiveNetworkFailures = 0
  private consecutiveProxyGatewayFailures = 0
  private consecutiveServiceRejections = 0
  private readonly maxConsecutiveNetworkFailures: number
  private readonly maxConsecutiveProxyGatewayFailures: number
  private readonly maxConsecutiveServiceRejections: number

  constructor(options: RegistrationCircuitOptions = {}) {
    this.maxConsecutiveNetworkFailures = Math.max(1, options.maxConsecutiveNetworkFailures ?? 5)
    this.maxConsecutiveProxyGatewayFailures = Math.max(1, options.maxConsecutiveProxyGatewayFailures ?? 3)
    this.maxConsecutiveServiceRejections = Math.max(1, options.maxConsecutiveServiceRejections ?? 3)
  }

  reset(): void {
    this.consecutiveNetworkFailures = 0
    this.consecutiveProxyGatewayFailures = 0
    this.consecutiveServiceRejections = 0
  }

  record(event: RegistrationCircuitEvent): RegistrationCircuitDecision {
    if (event === 'risk_control') {
      return this.decision(true, 'AWS/Kiro risk control rejected the registration flow')
    }
    if (event === 'account_suspended') {
      return this.decision(true, 'AWS/Kiro suspended a newly registered account')
    }
    if (event === 'network_route_failed') {
      this.consecutiveNetworkFailures += 1
      if (this.consecutiveNetworkFailures >= this.maxConsecutiveNetworkFailures) {
        return this.decision(
          true,
          `${this.consecutiveNetworkFailures} consecutive proxy routes failed preflight`
        )
      }
      return this.decision(false)
    }
    if (event === 'network_route_ok') {
      this.consecutiveNetworkFailures = 0
      return this.decision(false)
    }
    if (event === 'proxy_gateway_rejected') {
      this.consecutiveProxyGatewayFailures += 1
      if (this.consecutiveProxyGatewayFailures >= this.maxConsecutiveProxyGatewayFailures) {
        return this.decision(
          true,
          `${this.consecutiveProxyGatewayFailures} consecutive proxy gateways returned HTML 403 for AWS sign-in`
        )
      }
      return this.decision(false)
    }
    if (event === 'service_rejected') {
      this.consecutiveServiceRejections += 1
      if (this.consecutiveServiceRejections >= this.maxConsecutiveServiceRejections) {
        return this.decision(
          true,
          `${this.consecutiveServiceRejections} consecutive registration requests were rejected by AWS/Kiro`
        )
      }
      return this.decision(false)
    }

    this.consecutiveProxyGatewayFailures = 0
    this.consecutiveServiceRejections = 0
    return this.decision(false)
  }

  private decision(stop: boolean, reason?: string): RegistrationCircuitDecision {
    return {
      stop,
      reason,
      consecutiveNetworkFailures: this.consecutiveNetworkFailures,
      consecutiveProxyGatewayFailures: this.consecutiveProxyGatewayFailures,
      consecutiveServiceRejections: this.consecutiveServiceRejections
    }
  }
}
