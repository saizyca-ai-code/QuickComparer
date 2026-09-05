/**
 * 本機服務的 client。
 *
 * 路徑一律用相對的 `/api/...`：開發期由 vite proxy 轉到 5274，打包後兩者同源。
 * 前端不需要知道服務跑在哪個 port，Phase 7 換打包形式時這裡不用改。
 *
 * 服務不是必要的 —— 拖放路徑完全不經過它。所以每個呼叫都要能在服務沒起來的
 * 情況下乾淨地失敗，而不是讓整個 UI 卡住。
 */

const API_BASE = '/api'

export interface HealthInfo {
  ok: boolean
  version: string
  /** ffprobe 的實際路徑。null 代表找不到，metadata 會整組失效。 */
  ffprobe: string | null
  ffprobeError: string | null
}

export interface ProjectInfo {
  path: string | null
  exists: boolean
}

export interface MediaEntry {
  /** 相對於專案資料夾的 POSIX 路徑，前端一律用它當識別。 */
  rel_path: string
  name: string
  size: number
  modified: number
  kind: 'video' | 'image'
}

/** 容器裡的色彩標記。每一欄都可能是 null —— 那代表容器沒寫，不是預設值。 */
export interface ProbeColorSpace {
  primaries: string | null
  transfer: string | null
  matrix: string | null
  full_range: boolean | null
}

export interface ProbeInfo {
  path: string
  kind: 'video' | 'image'
  size: number
  mime: string
  duration?: number | null
  width?: number | null
  height?: number | null
  frame_rate?: number | null
  codec?: string | null
  frame_count?: number | null
  /** 1 代表整支只有一個 keyframe，seek 成本會隨距離線性成長。 */
  keyframe_count?: number | null
  has_b_frames?: number | null
  color_space?: ProbeColorSpace
  warnings?: string[]
}

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, init)
  } catch (e) {
    // 服務沒起來時 fetch 直接拋，訊息是 'Failed to fetch' —— 對使用者沒有意義，
    // 換成講得出下一步的說法。
    throw new ApiError(0, `連不上本機服務：${e instanceof Error ? e.message : String(e)}`)
  }

  if (!response.ok) {
    let detail = `HTTP ${response.status}`
    try {
      const body = (await response.json()) as { detail?: string }
      if (body.detail) detail = body.detail
    } catch {
      // 回應不是 JSON 就沿用狀態碼。
    }
    throw new ApiError(response.status, detail)
  }

  return (await response.json()) as T
}

export function health(): Promise<HealthInfo> {
  return request<HealthInfo>('/health')
}

export function getProject(): Promise<ProjectInfo> {
  return request<ProjectInfo>('/project')
}

export function setProject(path: string): Promise<ProjectInfo> {
  return request<ProjectInfo>('/project', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })
}

export async function listMedia(): Promise<MediaEntry[]> {
  const data = await request<{ items: MediaEntry[] }>('/media')
  return data.items
}

export function probeMedia(relPath: string): Promise<ProbeInfo> {
  return request<ProbeInfo>(`/probe?path=${encodeURIComponent(relPath)}`)
}

/** 檔案供應的 URL。ByteSource 會對它下 Range 請求。 */
export function fileUrl(relPath: string): string {
  return `${API_BASE}/file?path=${encodeURIComponent(relPath)}`
}
