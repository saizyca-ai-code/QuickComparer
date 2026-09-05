/**
 * mp4 demux：把整個檔案拆成 EncodedVideoChunk 所需的樣本清單。
 *
 * 刻意一次把「壓縮」樣本全部讀進記憶體：這是壓縮資料，短片段只有幾十 MB，
 * 換來的是完整的 keyframe index 與 O(1) 的 seek 目標查找。
 * D001 禁止的是預先解碼成 frame cache（未壓縮，4K 約 12–66 MB/幀），不是預先 demux。
 */

import MP4Box, { type MP4File, type MP4Info, type MP4Sample, type MP4VideoTrack } from 'mp4box'
import { type ColorSpaceInfo } from './FrameSource'
import type { ByteSource } from './ByteSource'

export interface DemuxedSample {
  /** 秒。 */
  timestamp: number
  /** 秒。 */
  duration: number
  isKeyframe: boolean
  data: Uint8Array
}

export interface DemuxResult {
  config: VideoDecoderConfig
  samples: DemuxedSample[]
  /** samples 中每個 keyframe 的索引，遞增。 */
  keyframeIndices: number[]
  width: number
  height: number
  /** 秒。 */
  duration: number
  frameRate: number
  colorSpace: ColorSpaceInfo
  codec: string
}

/** 從 stsd 取出 codec-specific description（avcC / hvcC / vpcC / av1C）。 */
function extractDescription(file: MP4File, trackId: number): Uint8Array | undefined {
  const trak = file.getTrackById(trackId)
  const entries = trak?.mdia?.minf?.stbl?.stsd?.entries
  if (!entries) return undefined

  for (const entry of entries) {
    const box = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C
    if (!box) continue
    const stream = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN)
    box.write(stream)
    // 去掉 8 bytes 的 box header，VideoDecoder 只要 payload。
    return new Uint8Array(stream.buffer.slice(8))
  }
  return undefined
}

/**
 * 讀出容器的色彩標記。
 *
 * mp4box 只在有 colr box 時才提供這些值，而 AI 產生的片段經常整個缺漏，
 * 所以每一項都獨立處理成 null，讓上層知道哪些是真的、哪些要用假設值補。
 */
function readColorSpace(track: MP4VideoTrack, file: MP4File): ColorSpaceInfo {
  const trak = file.getTrackById(track.id)
  const entries = trak?.mdia?.minf?.stbl?.stsd?.entries ?? []

  for (const entry of entries) {
    const colr = entry.colr
    if (!colr) continue
    return {
      primaries: colourPrimariesName(colr.colour_primaries),
      transfer: transferCharacteristicsName(colr.transfer_characteristics),
      matrix: matrixCoefficientsName(colr.matrix_coefficients),
      fullRange: colr.full_range_flag === undefined ? null : Boolean(colr.full_range_flag),
      origin: 'container',
    }
  }

  return { primaries: null, transfer: null, matrix: null, fullRange: null, origin: 'container' }
}

// ISO/IEC 23001-8 的代碼對應。只列實務上會遇到的，其餘回傳 null 而非硬猜。
function colourPrimariesName(v: number | undefined): string | null {
  switch (v) {
    case 1: return 'bt709'
    case 5: return 'bt470bg'
    case 6: return 'smpte170m'
    case 9: return 'bt2020'
    default: return null
  }
}

function transferCharacteristicsName(v: number | undefined): string | null {
  switch (v) {
    case 1: return 'bt709'
    case 6: return 'smpte170m'
    case 13: return 'iec61966-2-1'
    case 16: return 'smpte2084'  // PQ，HDR。目前範圍外，但要能辨識出來並警告。
    case 18: return 'arib-std-b67'  // HLG
    default: return null
  }
}

function matrixCoefficientsName(v: number | undefined): string | null {
  switch (v) {
    case 1: return 'bt709'
    case 5: return 'bt470bg'
    case 6: return 'smpte170m'
    case 9: return 'bt2020-ncl'
    default: return null
  }
}

export async function demuxMp4(source: ByteSource): Promise<DemuxResult> {
  const mp4 = MP4Box.createFile()
  const samples: DemuxedSample[] = []

  const ready = new Promise<{ info: MP4Info; track: MP4VideoTrack }>((resolve, reject) => {
    mp4.onError = (e: string) => reject(new Error(`mp4box demux 失敗：${e}`))
    mp4.onReady = (info: MP4Info) => {
      const track = info.videoTracks[0]
      if (!track) {
        reject(new Error('檔案裡沒有影片軌'))
        return
      }
      resolve({ info, track })
    }
  })

  const buffer = await source.readAll()
  const chunk = buffer as ArrayBuffer & { fileStart?: number }
  chunk.fileStart = 0
  mp4.appendBuffer(chunk)

  const { info, track } = await ready

  const timescale = track.timescale
  const done = new Promise<void>((resolve) => {
    mp4.onSamples = (_id: number, _user: unknown, incoming: MP4Sample[]) => {
      for (const s of incoming) {
        samples.push({
          timestamp: s.cts / timescale,
          duration: s.duration / timescale,
          isKeyframe: s.is_sync,
          data: new Uint8Array(s.data),
        })
      }
      if (samples.length >= track.nb_samples) resolve()
    }
  })

  mp4.setExtractionOptions(track.id, null, { nbSamples: track.nb_samples })
  mp4.start()
  mp4.flush()
  await done

  // 絕對不能依 presentation order 重排。
  //
  // mp4box 依 decode order 交付，而 VideoDecoder 要的正是 decode order ——
  // 有 B-frame 時兩者不同，改成 presentation order 會讓 B-frame 早於它的參考影格
  // 送進解碼器，畫面碎成 macroblock 雜訊。只有 has_b_frames=0 的檔案看起來正常，
  // 所以這個 bug 很容易在測試素材上漏掉。
  //
  // 合成需要的 presentation order 由 Mp4FrameSource 在「輸出端」排序處理：
  // 解碼器吐出的 VideoFrame 帶著 presentation timestamp，插入緩衝時才排序。

  const keyframeIndices: number[] = []
  samples.forEach((s, i) => {
    if (s.isKeyframe) keyframeIndices.push(i)
  })
  if (keyframeIndices.length === 0 && samples.length > 0) {
    // 沒有任何 sync sample 的檔案（少見但存在）。當作全部可解，seek 一律從頭。
    keyframeIndices.push(0)
  }

  const duration = info.duration / info.timescale
  const description = extractDescription(mp4, track.id)

  const config: VideoDecoderConfig = {
    codec: track.codec,
    codedWidth: track.video.width,
    codedHeight: track.video.height,
    // hardware 優先，這正是 Phase 0 要量測的路徑。
    hardwareAcceleration: 'prefer-hardware',
    optimizeForLatency: true,
    ...(description ? { description } : {}),
  }

  mp4.stop()

  return {
    config,
    samples,
    keyframeIndices,
    width: track.video.width,
    height: track.video.height,
    duration,
    frameRate: duration > 0 ? track.nb_samples / duration : 0,
    colorSpace: readColorSpace(track, mp4),
    codec: track.codec,
  }
}
