/**
 * 底部區：資訊列、工具列、timeline。
 *
 * 三層的順序照 Chaos Player。track 區目前只有一條 timeline —— N 軌是 Phase 4
 * 的事，這裡先把位置留出來，免得屆時又要重排一次版面。
 */

import { clockState, params, playback, scrubbing, showSide, slots, transport } from '../app/state'
import { panels, togglePanel, viewerFullscreen } from '../app/layout'
import { rendererOrNull } from '../app/loop'

export function BottomBar() {
  if (viewerFullscreen.value) return null
  const open = panels.value.bottom

  return (
    <section id="bottom" class={open ? undefined : 'collapsed'}>
      <InfoStrip />
      {open && (
        <>
          <Toolbar />
          <Timeline />
        </>
      )}
    </section>
  )
}

/** 資訊列。收合狀態下也保留，它同時是底部區的展開把手。 */
function InfoStrip() {
  const [a, b] = slots.value
  const clock = clockState.value
  const p = params.value
  const info = a?.info ?? b?.info
  const canvas = rendererOrNull()
  const open = panels.value.bottom

  return (
    <div id="infoStrip">
      <button
        class="link"
        title={open ? '收合底部面板' : '展開底部面板'}
        onClick={() => togglePanel('bottom')}
      >
        {open ? '▾' : '▴'}
      </button>
      <span>{info ? `${info.width}×${info.height}` : '—'}</span>
      <span>{info ? `${info.frameRate.toFixed(2)} fps` : '—'}</span>
      <span>{Math.round(p.zoom * 100)}%</span>
      <span class="mono">
        {clock.duration > 0
          ? `${clock.currentTime.toFixed(3)} / ${clock.duration.toFixed(3)} s`
          : '— / —'}
      </span>
      <span class="spacer" />
      <span class="dim">{canvas ? '' : '初始化中…'}</span>
    </div>
  )
}

/** 工具列：傳輸鍵與 A/B 切換。Phase 2 的比對模式選擇也會放這裡。 */
function Toolbar() {
  const clock = clockState.value
  const enabled = slots.value[0] !== null || slots.value[1] !== null
  const p = params.value
  const switching = p.layout === 'single' && p.compareMode === 'single'

  return (
    <div id="toolbar">
      <div id="sideToggle" title="切換顯示 A / B（S）">
        {([0, 1] as const).map((side) => (
          <button
            key={side}
            class={switching && p.showSource === side ? 'active' : undefined}
            disabled={!enabled}
            onClick={() => showSide(side)}
          >
            {side === 0 ? 'A' : 'B'}
          </button>
        ))}
      </div>

      <div class="toolbar-group">
        <button disabled={!enabled} onClick={() => transport.step(-1)} title="上一格（←）">
          ◀
        </button>
        <button class="wide" disabled={!enabled} onClick={() => transport.toggle()} title="播放／暫停（空白鍵）">
          {clock.playing ? '暫停' : '播放'}
        </button>
        <button disabled={!enabled} onClick={() => transport.step(1)} title="下一格（→）">
          ▶
        </button>
      </div>

      <span class="spacer" />

      <button
        class="wide"
        title="全螢幕檢視（Tab）"
        onClick={() => {
          viewerFullscreen.value = true
        }}
      >
        全螢幕
      </button>
    </div>
  )
}

/** Timeline。Phase 4 會在這下面長出 N 條軌。 */
function Timeline() {
  const clock = clockState.value
  const enabled = slots.value[0] !== null || slots.value[1] !== null

  return (
    <div id="timeline">
      <input
        type="range"
        id="scrub"
        min={0}
        max={1000}
        step={1}
        disabled={!enabled}
        value={clock.duration > 0 ? (clock.currentTime / clock.duration) * 1000 : 0}
        onPointerDown={() => {
          scrubbing.value = true
        }}
        onPointerUp={() => {
          scrubbing.value = false
        }}
        onInput={(e) => {
          if (clock.duration <= 0) return
          const target = (Number((e.target as HTMLInputElement).value) / 1000) * clock.duration
          // 拖動時不逐格 seek 解碼器 —— 那會讓拖動變成一連串 flush。
          transport.scrubTo(target)
        }}
        onChange={() => {
          void transport.commitScrub()
        }}
      />
      <div id="trackArea">
        {([0, 1] as const).map((slot) => {
          const state = slots.value[slot]
          return (
            <div class={`track${state ? '' : ' empty'}`} key={slot}>
              <span class="track-tag">{slot === 0 ? 'A' : 'B'}</span>
              <span class="track-name">{state?.name ?? '—'}</span>
              <span class="track-len">
                {state ? `${state.info.duration.toFixed(2)} s` : ''}
              </span>
            </div>
          )
        })}
      </div>
      {playback.sources.every((s) => s === null) && (
        <p class="hint">多軌與 time offset 是 Phase 4 的範圍，目前是兩個比較槽。</p>
      )}
    </div>
  )
}
