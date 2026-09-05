/** 左panel：專案工具與素材槽。 */

import { clearSlot, loadFile, slots, type Slot } from '../app/state'
import { ProjectPanel } from './ProjectPanel'

export function LeftPanelContent() {
  return (
    <>
      <ProjectPanel />
      <SourceSlots />
    </>
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
