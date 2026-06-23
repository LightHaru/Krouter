import { describe, expect, it, vi } from 'vitest'
import { newConfig } from '../../src/main/registration/config'
import { Registrar } from '../../src/main/registration/registrar'

const HTML_FORBIDDEN = '<html><head><title>403 Forbidden</title></head><body><center><h1>403 Forbidden</h1></center></body></html>'

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
})
