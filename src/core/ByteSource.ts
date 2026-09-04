/**
 * ByteSource：素材位元組的來源。
 *
 * 拖放進來的 File 與服務供應的 HTTP 檔案，對 demuxer 來說唯一的差別就是
 * 「怎麼拿到 bytes」。把這件事抽出來，`Mp4FrameSource` 與 `demuxMp4` 就不必知道
 * 素材是本機拖進來的還是專案資料夾裡的。
 *
 * 這一層刻意不做快取或預讀策略。目前 demux 一次讀完整個檔案（見 demux.ts 的
 * 說明：壓縮資料，短片段只有幾十 MB，換來完整的 keyframe index），所以 read()
 * 的存在不是為了現在，而是為了日後真的需要漸進 demux 時不必改動呼叫端。
 */

export interface ByteSource {
  /** 顯示用的名稱，通常是檔名。 */
  readonly name: string
  /** MIME type。判斷是影片還是圖片用。 */
  readonly mimeType: string
  /** 位元組數。未知時為 -1。 */
  readonly size: number
  /** 讀取 [start, end) 的位元組。 */
  read(start: number, end: number): Promise<ArrayBuffer>
  /** 讀取整個檔案。 */
  readAll(): Promise<ArrayBuffer>
  /** 取得 Blob。createImageBitmap 需要它。 */
  blob(): Promise<Blob>
}

/** 拖放或檔案選取得到的 File。 */
export class FileByteSource implements ByteSource {
  #file: File

  constructor(file: File) {
    this.#file = file
  }

  get name(): string {
    return this.#file.name
  }

  get mimeType(): string {
    return this.#file.type
  }

  get size(): number {
    return this.#file.size
  }

  async read(start: number, end: number): Promise<ArrayBuffer> {
    return this.#file.slice(start, end).arrayBuffer()
  }

  async readAll(): Promise<ArrayBuffer> {
    return this.#file.arrayBuffer()
  }

  async blob(): Promise<Blob> {
    return this.#file
  }
}

/**
 * 由本機服務以 byte-range 供應的檔案。
 *
 * 大小從 `Content-Range` 取得而不是另外呼叫 HEAD：服務沒有實作 HEAD，
 * 而 `bytes=0-0` 這個一位元組的請求本來就會回報完整長度，多一個端點不划算。
 */
export class HttpByteSource implements ByteSource {
  readonly name: string
  readonly mimeType: string
  #url: string
  #size: number

  constructor(url: string, meta: { name: string; mimeType: string; size?: number }) {
    this.#url = url
    this.name = meta.name
    this.mimeType = meta.mimeType
    this.#size = meta.size ?? -1
  }

  static async open(
    url: string,
    meta: { name: string; mimeType: string },
  ): Promise<HttpByteSource> {
    const source = new HttpByteSource(url, meta)
    await source.#probeSize()
    return source
  }

  get size(): number {
    return this.#size
  }

  async read(start: number, end: number): Promise<ArrayBuffer> {
    // Range 是含頭含尾的，介面是 [start, end)，所以尾端要減 1。
    const response = await fetch(this.#url, {
      headers: { Range: `bytes=${start}-${end - 1}` },
    })
    if (response.status !== 206) {
      throw new Error(`供片服務不支援 byte-range（回應 ${response.status}）：${this.#url}`)
    }
    return response.arrayBuffer()
  }

  async readAll(): Promise<ArrayBuffer> {
    const response = await fetch(this.#url)
    if (!response.ok) throw new Error(`取不到 ${this.name}：${response.status}`)
    return response.arrayBuffer()
  }

  async blob(): Promise<Blob> {
    const response = await fetch(this.#url)
    if (!response.ok) throw new Error(`取不到 ${this.name}：${response.status}`)
    return response.blob()
  }

  async #probeSize(): Promise<void> {
    const response = await fetch(this.#url, { headers: { Range: 'bytes=0-0' } })
    if (response.status !== 206) {
      throw new Error(`供片服務不支援 byte-range（回應 ${response.status}）：${this.#url}`)
    }
    const contentRange = response.headers.get('content-range')
    const total = contentRange?.split('/')[1]
    const parsed = total === undefined ? Number.NaN : Number(total)
    if (!Number.isFinite(parsed)) {
      throw new Error(`供片服務沒有回報檔案大小（Content-Range: ${contentRange}）`)
    }
    this.#size = parsed
  }
}
