/**
 * 除錯面板：HUD、量測工具與訊息紀錄。
 *
 * 預設收合。這些是開發用的東西，不該是使用者比對畫面時要繞過的東西 ——
 * 但也不能刪，每個 Phase 都要用它們重測色彩來回、影格帳目與 seek 成本。
 */

import {
  busy,
  exportMeasurements,
  runBenchmark,
  runPassthroughTest,
  runProbe,
  runSeekTest,
  seekRecorder,
} from '../app/debug'
import { frameTimer, heapMonitor, liveStats, rendererOrNull } from '../app/loop'
import { debugOpen, isVideo, messages, playback, slots } from '../app/state'
import { formatBytes } from './stats'

export function DebugPanel() {
  const open = debugOpen.value

  return (
    <>
      <h2>
        <button class="link section-toggle" onClick={() => (debugOpen.value = !open)}>
          {open ? '▾' : '▸'} 除錯
        </button>
      </h2>
      {open && <DebugBody />}
    </>
  )
}

function DebugBody() {
  const hasSource = slots.value.some((s) => s !== null)
  const hasVideo = slots.value.some((s) => s !== null && isVideo(s.bytes))
  const working = busy.value

  return (
    <>
      <Hud />
      <div class="btn-row">
        <button disabled={!hasSource || working !== null} onClick={() => void runSeekTest()}>
          Seek 測試
        </button>
        <button disabled={!hasSource || working !== null} onClick={runPassthroughTest}>
          色彩來回
        </button>
      </div>
      <div class="btn-row">
        <button disabled={!hasSource || working !== null} onClick={() => void runBenchmark()}>
          吞吐量 benchmark
        </button>
      </div>
      <div class="btn-row">
        <button disabled={!hasVideo || working !== null} onClick={() => void runProbe()}>
          並行解碼上限
        </button>
      </div>
      <div class="btn-row">
        <button onClick={exportMeasurements}>匯出量測 JSON</button>
      </div>
      {working && <p class="hint">{working}進行中…</p>}
      <Log />
    </>
  )
}

function Hud() {
  // liveStats 每 250ms 換一次，用它當這個面板的重繪節奏；
  // 影格統計本身是可變物件，不會自己觸發重繪。
  const live = liveStats.value
  const [a, b] = playback.sources
  const statsA = a?.stats()
  const statsB = b?.stats()
  const compositor = rendererOrNull()?.compositor
  if (!compositor) return null
  const caps = compositor.capabilities

  const fps = frameTimer.fps
  const fpsClass = fps >= 55 ? 'ok' : fps >= 28 ? 'warn' : 'bad'

  // A/B 錯開一幀以上就是同步出問題，這是 T001 最關鍵的一項。
  const [tsA, tsB] = playback.lastTimestamps
  let syncText = '—'
  let syncClass = ''
  if (tsA !== null && tsB !== null) {
    const deltaMs = Math.abs(tsA - tsB) * 1000
    const frameMs = 1000 / Math.max(1, a?.info.frameRate ?? 30)
    syncText = `${deltaMs.toFixed(1)} ms`
    syncClass = deltaMs <= frameMs * 0.5 ? 'ok' : deltaMs <= frameMs * 1.5 ? 'warn' : 'bad'
  }

  const growth = heapMonitor.growthPerMinute
  const growthClass = growth > 20 * 1024 * 1024 ? 'bad' : growth > 5 * 1024 * 1024 ? 'warn' : 'ok'

  const ledgerOk = [statsA, statsB].every(
    (s) => !s || s.decoded === s.dropped + s.buffered,
  )

  const rows: [string, preact.ComponentChildren][] = [
    ['fps', <span class={fpsClass}>{fps.toFixed(1)}</span>],
    ['影格時間 p95', `${frameTimer.p95.toFixed(1)} ms`],
    ['最差影格', `${frameTimer.worst.toFixed(1)} ms`],
    ['A/B 時間差', <span class={syncClass}>{syncText}</span>],
    ['緩衝影格', `${statsA?.buffered ?? 0} / ${statsB?.buffered ?? 0}`],
    ['緩衝估算 (NV12)', formatBytes(live.bufferedBytes)],
    ['解碼佇列', String((statsA?.queueSize ?? 0) + (statsB?.queueSize ?? 0))],
    ['已釋放影格', String((statsA?.dropped ?? 0) + (statsB?.dropped ?? 0))],
    [
      '影格帳目',
      <span class={ledgerOk ? 'ok' : 'bad'}>{ledgerOk ? '平衡' : '不平（有洩漏）'}</span>,
    ],
    ['供片', live.seeking ? 'seek 中' : live.starved ? <span class="warn">缺格</span> : '正常'],
    [
      'seek 延遲',
      seekRecorder.count > 0
        ? `${seekRecorder.mean.toFixed(0)} / ${seekRecorder.worst.toFixed(0)} ms`
        : '—',
    ],
    ['render graph', compositor.graph.names().join(' → ')],
    [
      '中間緩衝',
      caps.halfFloatRenderable ? (
        <span class="ok">rgba16f</span>
      ) : (
        <span class="bad">rgba8（線性光不成立）</span>
      ),
    ],
  ]

  if (heapMonitor.available) {
    rows.push(['JS heap', formatBytes(heapMonitor.current)])
    rows.push([
      'heap 成長',
      <span class={growthClass}>{formatBytes(Math.max(0, growth))}/min</span>,
    ])
  }

  return (
    <table class="stats">
      <tbody>
        {rows.map(([key, value]) => (
          <tr key={key}>
            <td>{key}</td>
            <td>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Log() {
  const lines = messages.value
  if (lines.length === 0) return null
  return <div id="log">{lines.join('\n')}</div>
}
