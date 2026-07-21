import { useState, useEffect } from 'react'
import { BookOpen, Copy, Check, ExternalLink, RefreshCw } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, Button, Badge } from '../ui'
import { useTranslation } from '@/hooks/useTranslation'

interface Skill {
  id: string
  name: string
  description: string
  version?: string
  tags?: string[]
  type: 'builtin' | 'custom'
  url: string
}

export function SkillsPage() {
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const [skills, setSkills] = useState<Skill[]>([])
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null)
  const [skillContent, setSkillContent] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadSkills()
  }, [])

  async function loadSkills() {
    setLoading(true)
    try {
      const res = await (window as any).api?.fetchSkillsList?.() as { skills?: Skill[] } | undefined
      if (res?.skills) {
        setSkills(res.skills)
      }
    } catch (error) {
      console.error('Failed to load skills:', error)
    } finally {
      setLoading(false)
    }
  }

  async function viewSkill(skill: Skill) {
    setSelectedSkill(skill)
    try {
      const res = await (window as any).api?.fetchSkillContent?.(skill.id) as { content?: string } | undefined
      if (res?.content) {
        setSkillContent(res.content)
      }
    } catch (error) {
      console.error('Failed to load skill content:', error)
      setSkillContent('Failed to load skill content.')
    }
  }

  async function copySkillURL(skill: Skill) {
    try {
      await navigator.clipboard.writeText(skill.url)
      setCopiedId(skill.id)
      setTimeout(() => setCopiedId(null), 2000)
    } catch {
      // fallback
      const input = document.createElement('input')
      input.value = skill.url
      document.body.appendChild(input)
      input.select()
      document.execCommand('copy')
      document.body.removeChild(input)
      setCopiedId(skill.id)
      setTimeout(() => setCopiedId(null), 2000)
    }
  }

  return (
    <div className="flex-1 p-6 space-y-6 overflow-auto">
      {/* Header */}
      <div className="page-hero p-6">
        <div className="relative flex items-center gap-4">
          <div className="p-3 rounded-xl bg-indigo-500 shadow-lg shadow-indigo-500/25">
            <BookOpen className="h-6 w-6 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Skills System</h1>
            <p className="text-muted-foreground">
              {isEn
                ? 'Drop-in capabilities for AI agents (Claude Code, Cursor, ChatGPT, ...)'
                : 'Kha nang tu dong cho AI agents (Claude Code, Cursor, ChatGPT, ...)'}
            </p>
          </div>
        </div>
      </div>

      {/* How to use */}
      <Card>
        <CardContent className="py-4">
          <h3 className="font-medium mb-2">{isEn ? 'How to use' : 'Cach su dung'}</h3>
          <p className="text-sm text-muted-foreground mb-3">
            {isEn
              ? 'Copy a skill URL below and paste it to your AI agent:'
              : 'Copy URL skill ben duoi va paste cho AI agent cua ban:'}
          </p>
          <code className="text-xs bg-muted px-2 py-1 rounded block">
            {isEn ? 'Tell your AI: ' : 'Noi voi AI: '}"Read this skill: http://localhost:5580/skills/krouter/SKILL.md"
          </code>
        </CardContent>
      </Card>

      {/* Skills List */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>{isEn ? 'Available Skills' : 'Skills co san'}</CardTitle>
            <Button size="sm" variant="ghost" onClick={loadSkills} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {skills.length === 0 && !loading && (
            <p className="text-sm text-muted-foreground text-center py-6">
              {isEn ? 'No skills found. Make sure the server is running.' : 'Khong tim thay skill nao. Dam bao server dang chay.'}
            </p>
          )}
          {skills.map(skill => (
            <div key={skill.id} className="flex items-center gap-3 p-3 border rounded-lg hover:bg-muted/50 transition-colors">
              <BookOpen className="h-5 w-5 text-primary shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="font-medium text-sm">{skill.name}</p>
                  <Badge variant="secondary" className="text-[10px]">
                    {skill.type}
                  </Badge>
                  {skill.version && (
                    <Badge variant="outline" className="text-[10px]">
                      v{skill.version}
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground truncate">{skill.description}</p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => viewSkill(skill)} title={isEn ? 'View' : 'Xem'}>
                <ExternalLink className="h-4 w-4" />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => copySkillURL(skill)} title={isEn ? 'Copy URL' : 'Copy URL'}>
                {copiedId === skill.id ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Skill Content Viewer */}
      {selectedSkill && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">{selectedSkill.name}</CardTitle>
              <Button size="sm" variant="ghost" onClick={() => setSelectedSkill(null)}>
                &times;
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <pre className="text-xs bg-muted p-4 rounded-lg overflow-auto max-h-[400px] whitespace-pre-wrap font-mono">
              {skillContent}
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
