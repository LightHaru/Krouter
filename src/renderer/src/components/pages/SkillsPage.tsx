import { useEffect, useMemo, useState } from 'react'
import { BookOpen, Check, Copy, FileCode2, Loader2, RefreshCw, Search, Sparkles, TerminalSquare } from 'lucide-react'
import { Badge, Button, Input } from '../ui'
import { useTranslation } from '@/hooks/useTranslation'
import { copyText } from '@/lib/utils'

interface Skill { id: string; name: string; description: string; version?: string; tags?: string[]; type: 'builtin' | 'custom'; url: string }

export function SkillsPage(): React.ReactNode {
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const [skills, setSkills] = useState<Skill[]>([])
  const [selected, setSelected] = useState<Skill | null>(null)
  const [content, setContent] = useState('')
  const [query, setQuery] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadSkills = async (): Promise<void> => {
    setLoading(true); setError(null)
    try {
      const api = window.api as typeof window.api & { fetchSkillsList?: () => Promise<{ skills?: Skill[] }> }
      const result = await api.fetchSkillsList?.()
      const next = result?.skills || []
      setSkills(next)
      if (!selected && next.length) void openSkill(next[0])
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Failed to load skills') }
    finally { setLoading(false) }
  }

  useEffect(() => { void loadSkills() }, [])

  const openSkill = async (skill: Skill): Promise<void> => {
    setSelected(skill); setContent('')
    try {
      const api = window.api as typeof window.api & { fetchSkillContent?: (id: string) => Promise<{ content?: string }> }
      const result = await api.fetchSkillContent?.(skill.id)
      setContent(result?.content || '')
    } catch (cause) { setContent(cause instanceof Error ? cause.message : 'Failed to load skill content') }
  }

  const copyUrl = async (skill: Skill): Promise<void> => {
    await copyText(skill.url)
    setCopied(skill.id)
    window.setTimeout(() => setCopied(null), 1800)
  }

  const filtered = useMemo(() => {
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
    return terms.length ? skills.filter((skill) => terms.every((term) => `${skill.name} ${skill.description} ${(skill.tags || []).join(' ')}`.toLowerCase().includes(term))) : skills
  }, [skills, query])

  return (
    <div className="skills-library flex-1 overflow-auto p-4 md:p-6">
      <header className="skills-head">
        <div><span><Sparkles /> AGENT CAPABILITY REGISTRY</span><h1>{isEn ? 'Skills library' : 'Thu vien Skills'}</h1><p>{isEn ? 'Inspect, compose and hand capabilities to any compatible coding agent.' : 'Xem, ket hop va cung cap nang luc cho coding agent tuong thich.'}</p></div>
        <div className="skills-instruction"><TerminalSquare /><div><small>{isEn ? 'AGENT INSTRUCTION' : 'LENH CHO AGENT'}</small><code>Read this skill: http://localhost:5580/skills/krouter/SKILL.md</code></div></div>
      </header>

      <div className="skills-metrics"><div><strong>{skills.length}</strong><span>{isEn ? 'available skills' : 'skills san sang'}</span></div><div><strong>{skills.filter((skill) => skill.type === 'builtin').length}</strong><span>built-in</span></div><div><strong>{new Set(skills.flatMap((skill) => skill.tags || [])).size}</strong><span>{isEn ? 'capability tags' : 'nhom nang luc'}</span></div></div>

      {error && <div className="provider-alert">{error}</div>}

      <div className="skills-workspace">
        <aside className="skills-index">
          <div className="skills-index-toolbar"><div className="provider-search"><Search /><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={isEn ? 'Search skills...' : 'Tim skill...'} /></div><Button size="icon" variant="ghost" onClick={() => void loadSkills()} disabled={loading}>{loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}</Button></div>
          <div className="skills-list">
            {filtered.map((skill, index) => <button key={skill.id} className={selected?.id === skill.id ? 'skill-index-row active' : 'skill-index-row'} onClick={() => void openSkill(skill)}><span>{String(index + 1).padStart(2, '0')}</span><div><strong>{skill.name}</strong><p>{skill.description}</p><small>{skill.type} {skill.version ? ` / v${skill.version}` : ''}</small></div><FileCode2 /></button>)}
            {!loading && !filtered.length && <div className="skills-empty">{isEn ? 'No skills match this search.' : 'Khong co skill phu hop.'}</div>}
          </div>
        </aside>

        <section className="skill-reader">
          {selected ? <><div className="skill-reader-head"><div><span>SKILL.md</span><h2>{selected.name}</h2><p>{selected.description}</p></div><div><Badge variant="secondary">{selected.type}</Badge><Button size="sm" variant="outline" onClick={() => void copyUrl(selected)}>{copied === selected.id ? <Check /> : <Copy />}{copied === selected.id ? (isEn ? 'Copied' : 'Da copy') : 'Copy URL'}</Button></div></div><div className="skill-tags">{(selected.tags || []).map((tag) => <Badge key={tag} variant="outline">{tag}</Badge>)}</div><pre>{content || (loading ? 'Loading...' : '')}</pre></> : <div className="skill-reader-empty"><BookOpen /><h2>{isEn ? 'Select a skill' : 'Chon mot skill'}</h2><p>{isEn ? 'Its complete instruction file will appear here.' : 'Noi dung huong dan day du se hien o day.'}</p></div>}
        </section>
      </div>
    </div>
  )
}
