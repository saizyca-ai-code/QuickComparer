/**
 * 專案資料夾面板：設定路徑、列出素材、指定載入到 A 或 B。
 *
 * 服務沒起來時整個面板降級為一行說明，不擋任何事 —— 拖放路徑不經過服務。
 */

import { useEffect, useState } from 'preact/hooks'
import { loadFromProject } from '../app/state'
import {
  busy,
  chooseProject,
  checkService,
  mediaItems,
  mediaProbes,
  probeItem,
  projectPath,
  refreshMedia,
  serviceError,
  serviceHealth,
} from '../app/project'
import type { MediaEntry } from '../app/api'

export function ProjectPanel() {
  useEffect(() => {
    void checkService()
  }, [])

  return (
    <>
      <h2>專案資料夾</h2>
      {serviceHealth.value === null ? <ServiceOffline /> : <ProjectBody />}
    </>
  )
}

function ServiceOffline() {
  return (
    <p class="hint">
      本機服務未啟動，專案資料夾功能停用。拖放素材不受影響。
      {serviceError.value && <> 　（{serviceError.value}）</>}
    </p>
  )
}

function ProjectBody() {
  const [draft, setDraft] = useState('')
  const path = projectPath.value
  const health = serviceHealth.value

  return (
    <>
      <div class="project-path">
        <input
          type="text"
          placeholder={path ?? '輸入資料夾完整路徑'}
          value={draft}
          disabled={busy.value}
          onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim()) void chooseProject(draft.trim())
          }}
        />
        <button
          disabled={busy.value || draft.trim() === ''}
          onClick={() => void chooseProject(draft.trim())}
        >
          設定
        </button>
      </div>
      {path && (
        <p class="hint">
          目前：<code>{path}</code>
        </p>
      )}
      {serviceError.value && <p class="hint bad">{serviceError.value}</p>}
      {health?.ffprobeError && <p class="hint warn">ffprobe 不可用：{health.ffprobeError}</p>}

      {path && (
        <>
          <div class="btn-row">
            <button disabled={busy.value} onClick={() => void refreshMedia()}>
              重新掃描
            </button>
          </div>
          <MediaList />
        </>
      )}
    </>
  )
}

function MediaList() {
  const items = mediaItems.value
  if (items.length === 0) return <p class="hint">這個資料夾裡沒有可用素材。</p>
  return (
    <div class="media-list">
      {items.map((item) => (
        <MediaRow key={item.rel_path} item={item} />
      ))}
    </div>
  )
}

function MediaRow({ item }: { item: MediaEntry }) {
  const [open, setOpen] = useState(false)
  const probe = mediaProbes.value[item.rel_path]

  return (
    <div class="media-item">
      <div class="media-head">
        <button
          class="link media-name"
          title={item.rel_path}
          onClick={() => {
            setOpen(!open)
            if (!open) void probeItem(item.rel_path)
          }}
        >
          {open ? '▾' : '▸'} {item.name}
        </button>
        <button onClick={() => void loadFromProject(0, item)} title="載入為 A">
          A
        </button>
        <button onClick={() => void loadFromProject(1, item)} title="載入為 B">
          B
        </button>
      </div>
      {open && <MediaMeta item={item} probe={probe} />}
    </div>
  )
}

function MediaMeta({
  item,
  probe,
}: {
  item: MediaEntry
  probe: (typeof mediaProbes.value)[string] | undefined
}) {
  if (!probe) return <p class="hint">讀取 metadata…</p>

  if (probe.kind === 'image') {
    return <p class="hint">圖片　{formatSize(item.size)}</p>
  }

  const cs = probe.color_space
  const tagged = cs && (cs.primaries || cs.transfer || cs.matrix)

  return (
    <div class="media-meta">
      <span>
        {probe.width}×{probe.height}
      </span>
      <span>{probe.frame_rate?.toFixed(2)} fps</span>
      <span>{probe.duration?.toFixed(2)} s</span>
      <span>{probe.frame_count} 格</span>
      <span class={probe.keyframe_count === 1 ? 'warn' : undefined}>
        {probe.keyframe_count} keyframe
      </span>
      <span class={tagged ? 'ok' : 'warn'}>{tagged ? cs?.transfer : '無色彩標記'}</span>
      <span>{formatSize(item.size)}</span>
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
