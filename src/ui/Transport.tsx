/** 傳輸控制列：播放、逐幀、timeline、A/B 切換。 */

import { clockState, params, scrubbing, showSide, slots, transport } from '../app/state'

export function Transport() {
  const clock = clockState.value
  const enabled = slots.value[0] !== null || slots.value[1] !== null
  const p = params.value
  const switching = p.layout === 'single' && p.compareMode === 'single'

  return (
    <div id="transport">
      <button
        class="wide"
        disabled={!enabled}
        onClick={() => transport.toggle()}
        title="空白鍵"
      >
        {clock.playing ? '暫停' : '播放'}
      </button>
      <button disabled={!enabled} onClick={() => transport.step(-1)} title="←">
        ◀
      </button>
      <button disabled={!enabled} onClick={() => transport.step(1)} title="→">
        ▶
      </button>

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
      <span id="timeLabel">
        {clock.duration > 0
          ? `${clock.currentTime.toFixed(3)} / ${clock.duration.toFixed(3)} s`
          : '— / —'}
      </span>
    </div>
  )
}
