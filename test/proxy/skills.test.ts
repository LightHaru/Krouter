// Phase 13 tests: Skills system
import { describe, it, expect } from 'vitest'
import { SkillsManager } from '../../src/main/proxy/skills'
import * as path from 'path'

describe('Phase 13: Skills System', () => {
  const builtinDir = path.join(__dirname, '../../docs/skills')
  const customDir = path.join(__dirname, '../../test-skills-custom')

  it('lists built-in skills from docs/skills/', () => {
    const mgr = new SkillsManager(builtinDir, customDir)
    const skills = mgr.listSkills('http://localhost:5580')

    expect(skills.length).toBeGreaterThanOrEqual(5)

    const krouter = skills.find(s => s.id === 'krouter')
    expect(krouter).toBeDefined()
    expect(krouter!.name).toBe('krouter')
    expect(krouter!.type).toBe('builtin')
    expect(krouter!.url).toContain('/skills/krouter/SKILL.md')
  })

  it('gets skill content by id', () => {
    const mgr = new SkillsManager(builtinDir, customDir)
    const content = mgr.getSkillContent('krouter')

    expect(content).not.toBeNull()
    expect(content).toContain('Krouter')
    expect(content).toContain('---')
  })

  it('returns null for unknown skill', () => {
    const mgr = new SkillsManager(builtinDir, customDir)
    const content = mgr.getSkillContent('nonexistent-skill')
    expect(content).toBeNull()
  })

  it('lists all expected built-in skills', () => {
    const mgr = new SkillsManager(builtinDir, customDir)
    const skills = mgr.listSkills('http://localhost:5580')
    const ids = skills.map(s => s.id)

    expect(ids).toContain('krouter')
    expect(ids).toContain('krouter-proxy')
    expect(ids).toContain('krouter-image')
    expect(ids).toContain('krouter-admin')
    expect(ids).toContain('krouter-mitm')
  })

  it('includes description from frontmatter', () => {
    const mgr = new SkillsManager(builtinDir, customDir)
    const skills = mgr.listSkills('http://localhost:5580')
    const proxy = skills.find(s => s.id === 'krouter-proxy')

    expect(proxy!.description).toBeTruthy()
    expect(proxy!.description.length).toBeGreaterThan(10)
  })
})
