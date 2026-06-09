import { useState } from 'react'
import {
  BookOpen,
  LogIn,
  Users,
  Server,
  Bot,
  Network,
  ImageOff,
  type LucideIcon
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '../ui'
import { APP_NAME } from '@/brand'
import { docsImages } from './docsImages'
import { DOC_SECTIONS } from './docsContent'

const SECTION_ICONS: Record<string, LucideIcon> = {
  setup: LogIn,
  accounts: Users,
  proxy: Server,
  openclaw: Bot,
  tunnel: Network
}

function scrollToSection(id: string): void {
  const el = document.getElementById(`docs-${id}`)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function StepImage({ image, alt }: { image?: string; alt?: string }): React.ReactNode {
  const [failed, setFailed] = useState(false)
  const src = image ? docsImages[image] : undefined
  const label = alt || 'Ảnh minh hoạ'

  if (!src || failed) {
    return (
      <div
        role="img"
        aria-label={label}
        className="mt-2 flex items-center gap-2 rounded-xl border border-dashed border-border bg-muted/30 px-4 py-6 text-xs text-muted-foreground"
      >
        <ImageOff className="h-4 w-4 shrink-0" />
        <span>{label}</span>
      </div>
    )
  }

  return (
    <img
      src={src}
      alt={label}
      onError={() => setFailed(true)}
      className="mt-2 w-full max-w-2xl h-auto max-h-[360px] object-contain object-left rounded-xl border border-border shadow-sm bg-muted/20"
      loading="lazy"
    />
  )
}

export function DocsPage(): React.ReactNode {
  return (
    <div className="flex-1 overflow-auto p-4 space-y-4 md:p-6 md:space-y-6">
      <div className="page-hero overflow-hidden p-5 md:p-8">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <BookOpen className="h-6 w-6" />
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-primary md:text-3xl">Hướng dẫn sử dụng {APP_NAME}</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground md:text-base">
              Hướng dẫn từng bước kèm ảnh chụp thật từ dashboard: thiết lập, thêm tài khoản, bật API proxy, import client và dùng tunnel.
            </p>
          </div>
        </div>
      </div>

      {/* Mục lục */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Mục lục</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {DOC_SECTIONS.map((section) => {
              const Icon = SECTION_ICONS[section.id] ?? BookOpen
              return (
                <button
                  key={section.id}
                  onClick={() => scrollToSection(section.id)}
                  className="flex items-center gap-2 rounded-xl border border-border bg-background/60 px-3 py-2 text-left text-sm transition hover:bg-muted/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  <Icon className="h-4 w-4 shrink-0 text-primary" />
                  <span className="min-w-0 truncate">{section.title}</span>
                </button>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {/* Các section */}
      {DOC_SECTIONS.map((section) => {
        const Icon = SECTION_ICONS[section.id] ?? BookOpen
        return (
          <Card key={section.id} id={`docs-${section.id}`} className="scroll-mt-4">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-3 text-base">
                <div className="rounded-lg bg-primary/10 p-2">
                  <Icon className="h-4 w-4 text-primary" />
                </div>
                {section.title}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm leading-relaxed text-muted-foreground">
              {section.intro && <p>{section.intro}</p>}
              <ol className="space-y-4">
                {section.steps.map((step, index) => (
                  <li key={index} className="flex gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-foreground/90">{step.text}</p>
                      {(step.image || step.alt) && <StepImage image={step.image} alt={step.alt} />}
                    </div>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
