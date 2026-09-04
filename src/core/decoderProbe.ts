/**
 * 並行解碼上限探測。
 *
 * D001 的結論之一：真正的限制不是素材長度，而是解析度乘以同時串流數。
 * 硬體解碼器的並行 session 數是驅動與晶片決定的，猜不出來，只能實測。
 * 這個探測的結果會變成 Grid 能開幾路的規格依據。
 */

import { demuxMp4, type DemuxResult } from './demux'
import { yieldToEventLoop } from './scheduling'

export interface ProbeResult {
  streams: number
  /** 全部串流合計的解碼影格率。 */
  totalFps: number
  /** 每條串流平均的解碼影格率。 */
  perStreamFps: number
  /** 是否達到即時（每條串流都跟得上素材的標稱 fps）。 */
  realtime: boolean
  errors: string[]
}

export interface ProbeOptions {
  /** 最多測到幾路。 */
  maxStreams?: number
  /** 每一輪測試持續多久（毫秒）。 */
  durationMs?: number
  onProgress?: (result: ProbeResult) => void
}

/**
 * 逐步增加並行解碼串流數，直到達到上限或不再即時。
 *
 * 每條串流都獨立建立 VideoDecoder 解同一份樣本，模擬 Grid 的最壞情況
 * （多路不同素材同時解碼）。解出的影格立刻 close，測的是純解碼吞吐量。
 */
export async function probeDecoderConcurrency(
  file: File,
  options: ProbeOptions = {},
): Promise<ProbeResult[]> {
  const maxStreams = options.maxStreams ?? 8
  const durationMs = options.durationMs ?? 2000

  const demuxed = await demuxMp4(file)
  const results: ProbeResult[] = []

  for (let streams = 1; streams <= maxStreams; streams += 1) {
    const result = await runProbe(demuxed, streams, durationMs)
    results.push(result)
    options.onProgress?.(result)

    // 已經明顯跟不上就不必再往上測，繼續加只會讓瀏覽器更難受。
    if (!result.realtime && streams > 1) break
    if (result.errors.length > 0) break
  }

  return results
}

async function runProbe(
  demuxed: DemuxResult,
  streams: number,
  durationMs: number,
): Promise<ProbeResult> {
  const errors: string[] = []
  let decodedTotal = 0

  const decoders: VideoDecoder[] = []
  for (let i = 0; i < streams; i += 1) {
    const decoder = new VideoDecoder({
      output: (frame) => {
        decodedTotal += 1
        // 立刻釋放：這裡測的是解碼吞吐量，不是緩衝策略。
        frame.close()
      },
      error: (e) => {
        errors.push(e instanceof Error ? e.message : String(e))
      },
    })
    decoder.configure(demuxed.config)
    decoders.push(decoder)
  }

  // 每條串流各自的樣本游標，循環播放素材直到時間到。
  const cursors = new Array<number>(streams).fill(0)
  const started = performance.now()

  try {
    while (performance.now() - started < durationMs && errors.length === 0) {
      for (let i = 0; i < streams; i += 1) {
        const decoder = decoders[i]
        if (!decoder || decoder.state !== 'configured') continue
        // 佇列壓在低水位，避免累積成一個假的高吞吐量數字。
        if (decoder.decodeQueueSize >= 4) continue

        const cursor = cursors[i] ?? 0
        const sample = demuxed.samples[cursor % demuxed.samples.length]
        if (!sample) continue

        // 循環時必須從 keyframe 重新開始，否則解碼器會因缺少參考影格而報錯。
        const wrapped = cursor > 0 && cursor % demuxed.samples.length === 0
        if (wrapped && !sample.isKeyframe) {
          cursors[i] = cursor + 1
          continue
        }

        decoder.decode(
          new EncodedVideoChunk({
            type: sample.isKeyframe ? 'key' : 'delta',
            timestamp: Math.round(sample.timestamp * 1e6),
            duration: Math.round(sample.duration * 1e6),
            data: sample.data,
          }),
        )
        cursors[i] = cursor + 1
      }

      // 讓出主執行緒，讓解碼器的 output callback 有機會跑。
      await yieldToEventLoop()
    }
  } finally {
    for (const decoder of decoders) {
      if (decoder.state !== 'closed') decoder.close()
    }
  }

  const elapsed = (performance.now() - started) / 1000
  const totalFps = decodedTotal / elapsed
  const perStreamFps = totalFps / streams

  return {
    streams,
    totalFps,
    perStreamFps,
    // 留 5% 餘裕，避免量測抖動造成誤判。
    realtime: perStreamFps >= demuxed.frameRate * 0.95,
    errors,
  }
}
