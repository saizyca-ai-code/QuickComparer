/** 檢視區：畫布、拖放、畫面上的直接操作。 */

import { useEffect, useRef, useState } from 'preact/hooks'
import { initRenderer, startLoop } from '../app/loop'
import {
  acceptFiles,
  hasAnySource,
  params,
  slots,
  stageAspect,
  updateParams,
} from '../app/state'
import { SplitInteraction, type Cursor } from './splitInteraction'

export function Viewer() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const interactionRef = useRef<SplitInteraction | null>(null)
  const [cursor, setCursor] = useState<Cursor>('default')
  const [dragOver, setDragOver] = useState(false)

  // 依賴陣列刻意留空：Renderer 與互動只該建立一次，之後靠 signal 取得最新參數。
  // 把 params 放進依賴會讓每次拖動分割線都重建一次 WebGL context。
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const renderer = initRenderer(canvas)
    const interaction = new SplitInteraction({
      canvas,
      compositor: renderer.compositor,
      params: () => params.peek(),
      aspect: stageAspect,
      apply: updateParams,
    })
    interactionRef.current = interaction
    startLoop()

    const onAlt = (e: KeyboardEvent) => {
      if (e.key !== 'Alt') return
      interaction.setAltKey(e.type === 'keydown')
      setCursor(interaction.cursor())
    }
    document.addEventListener('keydown', onAlt)
    document.addEventListener('keyup', onAlt)
    return () => {
      document.removeEventListener('keydown', onAlt)
      document.removeEventListener('keyup', onAlt)
    }
  }, [])

  const handle = (fn: (i: SplitInteraction, e: PointerEvent) => void) => (e: PointerEvent) => {
    const interaction = interactionRef.current
    if (!interaction) return
    fn(interaction, e)
    setCursor(interaction.cursor())
  }

  return (
    <div
      id="stage"
      class={dragOver ? 'dragging' : undefined}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={(e) => {
        if (e.relatedTarget === null) setDragOver(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        void acceptFiles(Array.from(e.dataTransfer?.files ?? []))
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ cursor }}
        onPointerDown={handle((i, e) => i.pointerDown(e))}
        onPointerMove={handle((i, e) => i.pointerMove(e))}
        onPointerUp={handle((i, e) => i.pointerUp(e))}
        onPointerLeave={handle((i) => i.pointerLeave())}
        onWheel={(e) => {
          e.preventDefault()
          interactionRef.current?.wheelZoom(e.deltaY)
        }}
      />
      {!hasAnySource() && <DropHint />}
      {hasAnySource() && <SideBadge />}
    </div>
  )
}

function DropHint() {
  return (
    <div id="dropHint">
      <strong>把兩個檔案拖進來</strong>
      <div>先拖的是 A，後拖的是 B。支援 mp4 與圖片。</div>
      <div>
        空白鍵播放／暫停　<code>←</code> <code>→</code> 逐幀　<code>S</code> 切換 A/B
      </div>
      <div>
        分割線可直接在畫面上拖曳，<code>Alt</code> + 拖曳為旋轉
      </div>
    </div>
  )
}

/** switch 模式下標出目前看的是哪一邊 —— 兩張畫面很像時，沒有標示會不知道在看什麼。 */
function SideBadge() {
  const p = params.value
  if (p.layout !== 'single' || p.compareMode !== 'single') return null
  const slot = slots.value[p.showSource]
  return (
    <div id="sideBadge">
      <strong>{p.showSource === 0 ? 'A' : 'B'}</strong>
      <span>{slot?.name ?? '（空）'}</span>
    </div>
  )
}
