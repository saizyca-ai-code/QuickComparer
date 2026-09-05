/** 側欄：素材槽與比對／檢視／色彩的參數。除錯工具在 DebugPanel。 */

import { clearSlot, loadFile, params, slots, updateParams, type Slot } from '../app/state'
import { DEFAULT_RENDER_PARAMS } from '../gl/params'
import type { CompareMode, Interpolation, Layout, TransferFunction } from '../gl/params'
import { normalizedSplitDegrees } from './splitInteraction'
import { DebugPanel } from './DebugPanel'
import { ProjectPanel } from './ProjectPanel'

export function Sidebar() {
  return (
    <aside>
      <ProjectPanel />
      <SourceSlots />
      <CompareSection />
      <ViewSection />
      <ColorSection />
      <DebugPanel />
    </aside>
  )
}

// ---------------------------------------------------------------- 素材

function SourceSlots() {
  return (
    <>
      <h2>素材</h2>
      {([0, 1] as const).map((slot) => (
        <SourceSlot key={slot} slot={slot} />
      ))}
    </>
  )
}

function SourceSlot({ slot }: { slot: Slot }) {
  const state = slots.value[slot]
  const label = slot === 0 ? 'A' : 'B'

  return (
    <div
      class={`slot${state ? '' : ' empty'}`}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        const file = e.dataTransfer?.files?.[0]
        if (file) void loadFile(slot, file)
      }}
    >
      <div class="slot-head">
        <span class="slot-tag">{label}</span>
        <span class="slot-name" title={state?.relPath ?? state?.name}>
          {state?.name ?? '拖檔案到這裡'}
        </span>
        {state?.origin === 'project' && <span class="slot-origin" title="來自專案資料夾">專案</span>}
        {state && (
          <button class="link" onClick={() => clearSlot(slot)} title="清除">
            ✕
          </button>
        )}
      </div>
      {state && (
        <div class="slot-meta">
          <span>
            {state.info.width}×{state.info.height}
          </span>
          <span>{state.info.frameRate.toFixed(2)} fps</span>
          <span>{state.info.duration.toFixed(2)} s</span>
          <span class={state.info.colorSpace.origin === 'container' ? 'ok' : 'warn'}>
            {state.info.colorSpace.transfer ?? '未標記'}
            {state.info.colorSpace.origin === 'assumed' ? '（假設）' : ''}
          </span>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- 比對

function CompareSection() {
  const p = params.value
  return (
    <>
      <h2>比對</h2>
      <Row label="佈局">
        <select
          value={p.layout}
          onChange={(e) => updateParams({ layout: (e.target as HTMLSelectElement).value as Layout })}
        >
          <option value="single">Single</option>
          <option value="horizontal">左右</option>
          <option value="vertical">上下</option>
          <option value="grid">Grid</option>
        </select>
      </Row>
      <Row label="模式">
        <select
          value={p.compareMode}
          onChange={(e) =>
            updateParams({ compareMode: (e.target as HTMLSelectElement).value as CompareMode })
          }
        >
          <option value="slider">Slider</option>
          <option value="single">Switch（A/B）</option>
          <option value="diff">Diff</option>
        </select>
      </Row>
      <Row label="分割位置">
        <input
          type="range"
          min={0}
          max={1}
          step={0.001}
          value={p.splitPos}
          onInput={(e) => updateParams({ splitPos: Number((e.target as HTMLInputElement).value) })}
        />
      </Row>
      <Row label="分割角度">
        <input
          type="range"
          min={-90}
          max={90}
          step={1}
          value={normalizedSplitDegrees(p.splitAngle)}
          onInput={(e) =>
            updateParams({
              splitAngle: (Number((e.target as HTMLInputElement).value) * Math.PI) / 180,
            })
          }
        />
      </Row>
      <Row label="Diff 倍率">
        <input
          type="range"
          min={1}
          max={32}
          step={1}
          value={p.diffGain}
          onInput={(e) => updateParams({ diffGain: Number((e.target as HTMLInputElement).value) })}
        />
      </Row>
    </>
  )
}

// ---------------------------------------------------------------- 檢視

function ViewSection() {
  const p = params.value
  return (
    <>
      <h2>檢視</h2>
      <Row label="插值">
        <select
          value={p.interpolation}
          onChange={(e) =>
            updateParams({
              interpolation: (e.target as HTMLSelectElement).value as Interpolation,
            })
          }
        >
          <option value="nearest">Nearest（預設）</option>
          <option value="bilinear">Bilinear</option>
          <option value="bicubic">Bicubic</option>
        </select>
      </Row>
      <Row label="Zoom">
        <input
          type="range"
          min={10}
          max={800}
          step={1}
          value={Math.round(p.zoom * 100)}
          onInput={(e) =>
            updateParams({ zoom: Number((e.target as HTMLInputElement).value) / 100 })
          }
        />
      </Row>
      <p class="hint">
        畫面上滾輪縮放、拖曳平移，A/B 同步。拖分割線本身可移動它，按住 <code>Alt</code>{' '}
        拖則是旋轉。
      </p>
      <button
        onClick={() =>
          updateParams({
            zoom: 1,
            pan: { ...DEFAULT_RENDER_PARAMS.pan },
            splitPos: DEFAULT_RENDER_PARAMS.splitPos,
            splitAngle: DEFAULT_RENDER_PARAMS.splitAngle,
          })
        }
      >
        重設檢視
      </button>
    </>
  )
}

// ---------------------------------------------------------------- 色彩

function ColorSection() {
  const p = params.value
  return (
    <>
      <h2>色彩</h2>
      <Row label="輸出">
        <select
          value={p.outputTransfer}
          onChange={(e) =>
            updateParams({
              outputTransfer: (e.target as HTMLSelectElement).value as TransferFunction,
            })
          }
        >
          <option value="srgb">sRGB</option>
          <option value="bt709">BT.709</option>
          <option value="linear">Linear（除錯）</option>
        </select>
      </Row>
      <label class="checkbox-row">
        <input
          type="checkbox"
          checked={p.toneMap}
          onChange={(e) => updateParams({ toneMap: (e.target as HTMLInputElement).checked })}
        />
        ACES 近似 tone map
      </label>
    </>
  )
}

function Row({ label, children }: { label: string; children: preact.ComponentChildren }) {
  return (
    <div class="row">
      <label>{label}</label>
      {children}
    </div>
  )
}
