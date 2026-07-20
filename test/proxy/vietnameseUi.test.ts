import { describe, expect, it } from 'vitest'
import { translateVietnameseText } from '../../src/renderer/src/i18n/vietnameseUi'

describe('Vietnamese UI translation', () => {
  it('does not mutate signed checkout URLs in log messages', () => {
    const url = 'https://checkout.stripe.com/c/pay/cs_live_a3dRRN2dUc1dmx9dNT2dyk3dic#fid'
    const log = `[Pro Link] account@example.com: ${url}`

    expect(translateVietnameseText(log)).toBe(log)
  })

  it('only translates day suffixes at token boundaries', () => {
    expect(translateVietnameseText('3d')).toBe('3 ngày')
    expect(translateVietnameseText('N2dUc')).toBe('N2dUc')
  })
})
