import { describe, expect, it, vi } from 'vitest'
import { newConfig } from '../../src/main/registration/config'
import { Registrar } from '../../src/main/registration/registrar'

const HTML_FORBIDDEN = '<html><head><title>403 Forbidden</title></head><body><center><h1>403 Forbidden</h1></center></body></html>'
const PROXY_DIAGNOSTICS = [
  'REMOTE_ADDR = 43.203.195.46',
  'REMOTE_PORT = 12345',
  'REQUEST_METHOD = POST',
  'REQUEST_URI = /client/register',
  'HTTP_HOST = oidc.us-east-1.amazonaws.com'
].join('\n')

describe('Registrar route failures', () => {
  it('identifies an HTML 403 page as a proxy gateway failure', () => {
    const registrar = new Registrar(newConfig()) as unknown as {
      formatErrorBody: (body: string, status: number) => string
    }

    expect(registrar.formatErrorBody(HTML_FORBIDDEN, 403)).toContain(
      'proxy gateway returned an HTML Forbidden page'
    )
  })

  it('fails WorkflowInit immediately when the route returns HTML 403', async () => {
    const registrar = new Registrar(newConfig()) as unknown as {
      workflowHandle: string
      doPost: ReturnType<typeof vi.fn>
      step5WorkflowInit: () => Promise<void>
    }
    registrar.workflowHandle = 'controlled-workflow'
    registrar.doPost = vi.fn().mockResolvedValue({
      status: 403,
      body: HTML_FORBIDDEN,
      headers: {}
    })

    await expect(registrar.step5WorkflowInit()).rejects.toThrow(
      'WorkflowInit Kiro failed: status=403 proxy gateway returned an HTML Forbidden page'
    )
    expect(registrar.doPost).toHaveBeenCalledTimes(1)
  })

  it('redacts proxy CGI diagnostics and classifies them as an unusable AWS route', () => {
    const registrar = new Registrar(newConfig()) as unknown as {
      formatErrorBody: (body: string, status: number) => string
    }

    const message = registrar.formatErrorBody(PROXY_DIAGNOSTICS, 200)
    expect(message).toContain('proxy gateway intercepted AWS OIDC request')
    expect(message).toContain('route/proxy is not usable for AWS sign-in')
    expect(message).not.toContain('43.203.195.46')
    expect(message).not.toContain('REMOTE_PORT')
  })

  it('fails OIDC immediately when the proxy intercepts client registration', async () => {
    const registrar = new Registrar(newConfig()) as unknown as {
      doPost: ReturnType<typeof vi.fn>
      step1OIDC: () => Promise<void>
    }
    registrar.doPost = vi.fn().mockResolvedValue({
      status: 200,
      body: PROXY_DIAGNOSTICS,
      headers: {}
    })

    await expect(registrar.step1OIDC()).rejects.toThrow('proxy gateway intercepted AWS OIDC request')
    expect(registrar.doPost).toHaveBeenCalledTimes(1)
  })
})
