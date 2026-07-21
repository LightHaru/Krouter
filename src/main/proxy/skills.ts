// Phase 13: Skills System - serves built-in and custom skill documents
import * as fs from 'fs'
import * as path from 'path'

export interface SkillInfo {
  id: string
  name: string
  description: string
  version?: string
  tags?: string[]
  type: 'builtin' | 'custom'
  url: string
}

interface SkillFrontmatter {
  name?: string
  description?: string
  version?: string
  tags?: string[]
}

function parseFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return { frontmatter: {}, body: content }

  const frontmatter: SkillFrontmatter = {}
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/)
    if (kv) {
      const key = kv[1] as keyof SkillFrontmatter
      const val = kv[2].trim()
      if (key === 'tags') {
        frontmatter.tags = val.replace(/[\[\]]/g, '').split(',').map(t => t.trim())
      } else {
        (frontmatter as Record<string, string>)[key] = val
      }
    }
  }
  return { frontmatter, body: match[2] }
}

export class SkillsManager {
  private builtinDir: string
  private customDir: string

  constructor(builtinDir: string, customDir: string) {
    this.builtinDir = builtinDir
    this.customDir = customDir
  }

  listSkills(baseUrl: string): SkillInfo[] {
    const skills: SkillInfo[] = []

    // Built-in skills
    if (fs.existsSync(this.builtinDir)) {
      for (const dir of fs.readdirSync(this.builtinDir)) {
        const skillFile = path.join(this.builtinDir, dir, 'SKILL.md')
        if (fs.existsSync(skillFile)) {
          const content = fs.readFileSync(skillFile, 'utf8')
          const { frontmatter } = parseFrontmatter(content)
          skills.push({
            id: dir,
            name: frontmatter.name || dir,
            description: frontmatter.description || '',
            version: frontmatter.version,
            tags: frontmatter.tags,
            type: 'builtin',
            url: `${baseUrl}/skills/${dir}/SKILL.md`
          })
        }
      }
    }

    // Custom skills
    if (fs.existsSync(this.customDir)) {
      for (const dir of fs.readdirSync(this.customDir)) {
        const skillFile = path.join(this.customDir, dir, 'SKILL.md')
        if (fs.existsSync(skillFile)) {
          const content = fs.readFileSync(skillFile, 'utf8')
          const { frontmatter } = parseFrontmatter(content)
          skills.push({
            id: `custom-${dir}`,
            name: frontmatter.name || dir,
            description: frontmatter.description || '',
            version: frontmatter.version,
            tags: frontmatter.tags,
            type: 'custom',
            url: `${baseUrl}/skills/custom-${dir}/SKILL.md`
          })
        }
      }
    }

    return skills
  }

  getSkillContent(skillId: string): string | null {
    // Try built-in
    const builtinPath = path.join(this.builtinDir, skillId, 'SKILL.md')
    if (fs.existsSync(builtinPath)) {
      return fs.readFileSync(builtinPath, 'utf8')
    }

    // Try custom (strip 'custom-' prefix)
    const customId = skillId.replace(/^custom-/, '')
    const customPath = path.join(this.customDir, customId, 'SKILL.md')
    if (fs.existsSync(customPath)) {
      return fs.readFileSync(customPath, 'utf8')
    }

    return null
  }
}
