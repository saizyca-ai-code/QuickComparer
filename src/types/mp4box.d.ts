/**
 * mp4box.js 的型別宣告。
 *
 * 上游沒有提供 .d.ts，且完整 API 面積很大。這裡只宣告 demux.ts 實際用到的部分，
 * 刻意不追求完整 —— 用到什麼補什麼，比抄一份會過期的完整宣告可靠。
 */
declare module 'mp4box' {
  export interface MP4VideoTrackVideo {
    width: number
    height: number
  }

  export interface MP4VideoTrack {
    id: number
    codec: string
    timescale: number
    duration: number
    nb_samples: number
    video: MP4VideoTrackVideo
  }

  export interface MP4Info {
    duration: number
    timescale: number
    videoTracks: MP4VideoTrack[]
    audioTracks: unknown[]
  }

  export interface MP4Sample {
    /** composition time stamp，單位是該軌的 timescale。 */
    cts: number
    /** decode time stamp。 */
    dts: number
    duration: number
    /** sync sample（keyframe）。 */
    is_sync: boolean
    data: ArrayBuffer
  }

  /** colr box。容器沒寫這個 box 時整個 colr 會是 undefined。 */
  export interface ColrBox {
    colour_primaries?: number
    transfer_characteristics?: number
    matrix_coefficients?: number
    full_range_flag?: number
  }

  /** codec-specific 設定 box，write() 會把自己序列化進 DataStream。 */
  export interface ConfigBox {
    write(stream: DataStream): void
  }

  export interface SampleDescriptionEntry {
    avcC?: ConfigBox
    hvcC?: ConfigBox
    vpcC?: ConfigBox
    av1C?: ConfigBox
    colr?: ColrBox
  }

  export interface Trak {
    mdia?: {
      minf?: {
        stbl?: {
          stsd?: { entries: SampleDescriptionEntry[] }
        }
      }
    }
  }

  export interface ExtractionOptions {
    nbSamples?: number
    rapAlignement?: boolean
  }

  export interface MP4File {
    onReady: (info: MP4Info) => void
    onError: (error: string) => void
    onSamples: (trackId: number, user: unknown, samples: MP4Sample[]) => void
    /** buffer 必須帶 fileStart 屬性標示它在檔案中的位移。 */
    appendBuffer(buffer: ArrayBuffer & { fileStart?: number }): number
    setExtractionOptions(trackId: number, user: unknown, options: ExtractionOptions): void
    start(): void
    stop(): void
    flush(): void
    getTrackById(trackId: number): Trak | undefined
  }

  export class DataStream {
    static BIG_ENDIAN: boolean
    static LITTLE_ENDIAN: boolean
    constructor(arrayBuffer?: ArrayBuffer, byteOffset?: number, endianness?: boolean)
    buffer: ArrayBuffer
  }

  export function createFile(): MP4File

  const MP4Box: {
    createFile: typeof createFile
    DataStream: typeof DataStream
  }
  export default MP4Box
}
