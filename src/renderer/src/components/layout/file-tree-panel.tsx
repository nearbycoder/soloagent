import { ChevronDown, ChevronRight, FileText, Folder, RefreshCw, Search, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'
import type { FileTreeEntry } from '../../../../shared/ipc/types'
import { Button } from '../ui/button'

type FileTreePanelProps = {
  projectRootPath?: string
  scopeKey: string
  spaceId?: string
  colorMode: 'light' | 'dark'
}

const ROOT_DIR_KEY = '__root__'
const INDENT_STEP_PX = 14
const SEARCH_DEBOUNCE_MS = 220
const SEARCH_RESULT_LIMIT = 200
const FILE_PREVIEW_MAX_BYTES = 512 * 1024

function toDirectoryKey(relativePath: string): string {
  return relativePath || ROOT_DIR_KEY
}

function detectLanguage(path: string): string {
  const lower = path.toLowerCase()

  if (lower.endsWith('.tsx') || lower.endsWith('.jsx')) return 'tsx'
  if (lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts')) return 'typescript'
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'javascript'
  if (lower.endsWith('.json')) return 'json'
  if (lower.endsWith('.md')) return 'markdown'
  if (lower.endsWith('.css')) return 'css'
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html'
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return 'yaml'
  if (lower.endsWith('.sh') || lower.endsWith('.bash') || lower.endsWith('.zsh')) return 'bash'
  if (lower.endsWith('.py')) return 'python'
  if (lower.endsWith('.go')) return 'go'
  if (lower.endsWith('.rs')) return 'rust'
  if (lower.endsWith('.java')) return 'java'
  if (lower.endsWith('.rb')) return 'ruby'
  if (lower.endsWith('.toml')) return 'toml'
  if (lower.endsWith('.xml')) return 'xml'
  if (lower.endsWith('.sql')) return 'sql'

  return 'text'
}

function gitStatusBadgeLabel(status?: FileTreeEntry['gitStatus']): string {
  if (status === 'modified') return 'M'
  if (status === 'added') return 'A'
  if (status === 'deleted') return 'D'
  if (status === 'renamed') return 'R'
  if (status === 'copied') return 'C'
  if (status === 'typechange') return 'T'
  if (status === 'conflict') return '!'
  if (status === 'untracked') return 'U'
  return ''
}

function gitStatusBadgeClasses(status?: FileTreeEntry['gitStatus']): string {
  if (status === 'modified') return 'border-amber-500/40 bg-amber-500/10 text-amber-300'
  if (status === 'added') return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
  if (status === 'deleted') return 'border-red-500/40 bg-red-500/10 text-red-300'
  if (status === 'renamed' || status === 'copied' || status === 'typechange') {
    return 'border-violet-500/40 bg-violet-500/10 text-violet-300'
  }
  if (status === 'conflict') return 'border-red-500/40 bg-red-500/10 text-red-300'
  if (status === 'untracked') return 'border-sky-500/40 bg-sky-500/10 text-sky-300'
  return 'border-border/60 bg-muted/30 text-muted-foreground'
}

export function FileTreePanel({
  projectRootPath,
  scopeKey,
  spaceId,
  colorMode
}: FileTreePanelProps): React.JSX.Element {
  const [entriesByDirectory, setEntriesByDirectory] = useState<Record<string, FileTreeEntry[]>>({})
  const [expandedDirectories, setExpandedDirectories] = useState<Record<string, boolean>>({
    [ROOT_DIR_KEY]: true
  })
  const [loadingByDirectory, setLoadingByDirectory] = useState<Record<string, boolean>>({})
  const [errorByDirectory, setErrorByDirectory] = useState<Record<string, string>>({})
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<FileTreeEntry[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewPath, setPreviewPath] = useState('')
  const [previewContent, setPreviewContent] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewTruncated, setPreviewTruncated] = useState(false)

  const rootEntries = entriesByDirectory[ROOT_DIR_KEY]
  const rootLoading = Boolean(loadingByDirectory[ROOT_DIR_KEY])
  const rootError = errorByDirectory[ROOT_DIR_KEY]
  const codeStyle = colorMode === 'dark' ? oneDark : oneLight
  const previewLanguage = useMemo(() => detectLanguage(previewPath), [previewPath])

  const loadDirectory = useCallback(
    async (relativePath: string): Promise<void> => {
      if (!projectRootPath) {
        return
      }

      const directoryKey = toDirectoryKey(relativePath)
      setLoadingByDirectory((state) => ({ ...state, [directoryKey]: true }))
      setErrorByDirectory((state) => {
        if (!state[directoryKey]) {
          return state
        }
        const next = { ...state }
        delete next[directoryKey]
        return next
      })

      const response = await window.api.app.fileTree({
        cwd: projectRootPath,
        relativePath
      })

      if (response.ok) {
        setEntriesByDirectory((state) => ({
          ...state,
          [directoryKey]: response.data
        }))
      } else {
        setErrorByDirectory((state) => ({
          ...state,
          [directoryKey]: response.error.message || 'Failed to load files.'
        }))
      }

      setLoadingByDirectory((state) => {
        const next = { ...state }
        delete next[directoryKey]
        return next
      })
    },
    [projectRootPath]
  )

  const openFilePreview = useCallback(
    async (relativePath: string): Promise<void> => {
      setPreviewOpen(true)
      setPreviewPath(relativePath)
      setPreviewContent('')
      setPreviewError(null)
      setPreviewLoading(true)
      setPreviewTruncated(false)

      if (!projectRootPath) {
        setPreviewLoading(false)
        setPreviewError('Select a project first.')
        return
      }

      const response = await window.api.app.fileRead({
        cwd: projectRootPath,
        path: relativePath,
        maxBytes: FILE_PREVIEW_MAX_BYTES
      })

      if (response.ok) {
        setPreviewPath(response.data.path)
        setPreviewContent(response.data.content)
        setPreviewTruncated(response.data.truncated)
      } else {
        setPreviewError(response.error.message || 'Failed to open file.')
      }
      setPreviewLoading(false)
    },
    [projectRootPath]
  )

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearchQuery(searchQuery.trim())
    }, SEARCH_DEBOUNCE_MS)

    return (): void => {
      window.clearTimeout(timer)
    }
  }, [searchQuery])

  useEffect(() => {
    setEntriesByDirectory({})
    setExpandedDirectories({ [ROOT_DIR_KEY]: true })
    setLoadingByDirectory({})
    setErrorByDirectory({})
    setSearchQuery('')
    setDebouncedSearchQuery('')
    setSearchResults([])
    setSearchLoading(false)
    setSearchError(null)
    setPreviewOpen(false)
    setPreviewPath('')
    setPreviewContent('')
    setPreviewLoading(false)
    setPreviewError(null)
    setPreviewTruncated(false)

    if (!projectRootPath) {
      return
    }

    void loadDirectory('')
  }, [loadDirectory, projectRootPath, scopeKey, spaceId])

  useEffect(() => {
    if (!projectRootPath || !debouncedSearchQuery) {
      setSearchResults([])
      setSearchError(null)
      setSearchLoading(false)
      return
    }

    let cancelled = false
    setSearchLoading(true)
    setSearchError(null)

    void window.api.app
      .fileTreeSearch({
        cwd: projectRootPath,
        query: debouncedSearchQuery,
        limit: SEARCH_RESULT_LIMIT
      })
      .then((response) => {
        if (cancelled) {
          return
        }

        if (response.ok) {
          setSearchResults(response.data)
          return
        }

        setSearchResults([])
        setSearchError(response.error.message || 'Search failed.')
      })
      .finally(() => {
        if (!cancelled) {
          setSearchLoading(false)
        }
      })

    return (): void => {
      cancelled = true
    }
  }, [debouncedSearchQuery, projectRootPath])

  useEffect(() => {
    if (!previewOpen) {
      return
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setPreviewOpen(false)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [previewOpen])

  const toggleDirectory = useCallback(
    (relativePath: string): void => {
      const directoryKey = toDirectoryKey(relativePath)
      const nextExpanded = !expandedDirectories[directoryKey]

      setExpandedDirectories((state) => ({
        ...state,
        [directoryKey]: nextExpanded
      }))

      if (
        nextExpanded &&
        entriesByDirectory[directoryKey] === undefined &&
        !loadingByDirectory[directoryKey]
      ) {
        void loadDirectory(relativePath)
      }
    },
    [entriesByDirectory, expandedDirectories, loadDirectory, loadingByDirectory]
  )

  const renderRows = useCallback(
    (relativePath: string, depth: number): React.JSX.Element[] => {
      const directoryKey = toDirectoryKey(relativePath)
      const entries = entriesByDirectory[directoryKey] || []

      return entries.map((entry) => {
        const rowPadding = `${8 + depth * INDENT_STEP_PX}px`

        if (entry.type === 'file') {
          return (
            <button
              key={entry.path}
              type="button"
              className={`flex w-full items-center gap-1 rounded-sm py-1 pr-2 text-left text-[11px] transition-colors hover:bg-accent hover:text-foreground ${
                entry.gitStatus ? 'text-foreground/95' : 'text-muted-foreground'
              }`}
              style={{ paddingLeft: rowPadding }}
              title={entry.path}
              onClick={() => void openFilePreview(entry.path)}
            >
              <FileText className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              {entry.gitStatus ? (
                <span
                  className={`ml-auto rounded-sm border px-1 py-[1px] text-[9px] font-semibold uppercase tracking-wide ${gitStatusBadgeClasses(entry.gitStatus)}`}
                  title={`Git status: ${entry.gitStatus}`}
                >
                  {gitStatusBadgeLabel(entry.gitStatus)}
                </span>
              ) : null}
            </button>
          )
        }

        const childKey = toDirectoryKey(entry.path)
        const expanded = Boolean(expandedDirectories[childKey])
        const childLoading = Boolean(loadingByDirectory[childKey])
        const childError = errorByDirectory[childKey]
        const childEntries = entriesByDirectory[childKey]

        return (
          <div key={entry.path}>
            <button
              type="button"
              className="flex w-full items-center gap-1 rounded-sm py-1 pr-2 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              style={{ paddingLeft: rowPadding }}
              onClick={() => toggleDirectory(entry.path)}
              title={entry.path}
            >
              {expanded ? (
                <ChevronDown className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 shrink-0" />
              )}
              <Folder className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{entry.name}</span>
            </button>

            {expanded ? (
              <div>
                {childLoading ? (
                  <div
                    className="py-1 pr-2 text-[11px] text-muted-foreground"
                    style={{ paddingLeft: `${8 + (depth + 1) * INDENT_STEP_PX}px` }}
                  >
                    Loading...
                  </div>
                ) : null}
                {childError ? (
                  <div
                    className="flex items-center gap-2 py-1 pr-2 text-[11px] text-destructive"
                    style={{ paddingLeft: `${8 + (depth + 1) * INDENT_STEP_PX}px` }}
                  >
                    <span className="truncate">{childError}</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[10px]"
                      onClick={() => void loadDirectory(entry.path)}
                    >
                      Retry
                    </Button>
                  </div>
                ) : null}
                {!childLoading && !childError && childEntries && childEntries.length === 0 ? (
                  <div
                    className="py-1 pr-2 text-[11px] text-muted-foreground"
                    style={{ paddingLeft: `${8 + (depth + 1) * INDENT_STEP_PX}px` }}
                  >
                    Empty folder
                  </div>
                ) : null}
                {!childLoading && !childError && childEntries
                  ? renderRows(entry.path, depth + 1)
                  : null}
              </div>
            ) : null}
          </div>
        )
      })
    },
    [
      entriesByDirectory,
      errorByDirectory,
      expandedDirectories,
      loadDirectory,
      loadingByDirectory,
      openFilePreview,
      toggleDirectory
    ]
  )

  const rows = useMemo(() => (rootEntries ? renderRows('', 0) : []), [renderRows, rootEntries])

  if (!projectRootPath) {
    return (
      <div className="rounded-md border border-border/70 bg-muted/40 p-2 text-xs text-muted-foreground">
        Select a project to browse files.
      </div>
    )
  }

  return (
    <>
      <div className="flex h-full min-h-0 flex-col">
        <div className="mb-2 flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search files"
              className="h-8 w-full rounded-md border border-border/70 bg-background pl-7 pr-7 text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
              aria-label="Search files"
            />
            {searchQuery ? (
              <button
                type="button"
                className="absolute right-1.5 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                onClick={() => setSearchQuery('')}
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 gap-1 px-2 text-[10px]"
            onClick={() => void loadDirectory('')}
            disabled={rootLoading}
            title="Refresh file tree"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${rootLoading ? 'animate-spin' : ''}`} />
          </Button>
        </div>

        <div className="mb-2 truncate text-[11px] text-muted-foreground" title={projectRootPath}>
          {projectRootPath}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border/70 bg-background/60 p-1">
          {debouncedSearchQuery ? (
            searchLoading ? (
              <div className="p-2 text-xs text-muted-foreground">Searching...</div>
            ) : searchError ? (
              <div className="p-2 text-xs text-destructive">{searchError}</div>
            ) : searchResults.length === 0 ? (
              <div className="p-2 text-xs text-muted-foreground">No files match your search.</div>
            ) : (
              <div className="space-y-0.5">
                {searchResults.map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    className={`flex w-full items-center gap-1 rounded-sm px-2 py-1 text-left text-[11px] transition-colors hover:bg-accent hover:text-foreground ${
                      entry.gitStatus ? 'text-foreground/95' : 'text-muted-foreground'
                    }`}
                    title={entry.path}
                    onClick={() => void openFilePreview(entry.path)}
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{entry.path}</span>
                    {entry.gitStatus ? (
                      <span
                        className={`ml-auto rounded-sm border px-1 py-[1px] text-[9px] font-semibold uppercase tracking-wide ${gitStatusBadgeClasses(entry.gitStatus)}`}
                        title={`Git status: ${entry.gitStatus}`}
                      >
                        {gitStatusBadgeLabel(entry.gitStatus)}
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            )
          ) : rootLoading && !rootEntries ? (
            <div className="p-2 text-xs text-muted-foreground">Loading files...</div>
          ) : rootError && !rootEntries ? (
            <div className="flex items-center justify-between gap-2 p-2 text-xs text-destructive">
              <span className="truncate">{rootError}</span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[10px]"
                onClick={() => void loadDirectory('')}
              >
                Retry
              </Button>
            </div>
          ) : rootEntries && rootEntries.length === 0 ? (
            <div className="p-2 text-xs text-muted-foreground">Project folder is empty.</div>
          ) : (
            <div className="space-y-0.5">{rows}</div>
          )}
        </div>
      </div>

      {previewOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3"
          onClick={() => setPreviewOpen(false)}
        >
          <div
            className="flex h-[92vh] w-[min(1280px,100%)] flex-col overflow-hidden rounded-lg border border-border/70 bg-background shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2 border-b border-border/70 px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{previewPath || 'File Preview'}</div>
                <div className="text-[11px] text-muted-foreground">
                  {previewTruncated ? 'Showing first 512 KB.' : 'Full file preview.'}
                </div>
              </div>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={() => setPreviewOpen(false)}
                title="Close"
                aria-label="Close file preview"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="min-h-0 flex-1 overflow-auto p-3">
              {previewLoading ? (
                <div className="rounded-md border border-border/70 bg-muted/40 p-2 text-xs text-muted-foreground">
                  Loading file...
                </div>
              ) : previewError ? (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                  {previewError}
                </div>
              ) : (
                <div className="overflow-hidden rounded-sm border border-border/70 bg-background/60">
                  <div className="border-b border-border/70 px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {previewLanguage}
                  </div>
                  <SyntaxHighlighter
                    language={previewLanguage}
                    style={codeStyle}
                    customStyle={{
                      margin: 0,
                      padding: '10px',
                      fontSize: '12px',
                      lineHeight: '1.45',
                      background: 'transparent'
                    }}
                    codeTagProps={{
                      style: {
                        fontFamily:
                          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace'
                      }
                    }}
                    wrapLongLines
                    showLineNumbers
                  >
                    {previewContent}
                  </SyntaxHighlighter>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
