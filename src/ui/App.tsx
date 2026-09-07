/**
 * 版面：Viewer 在左、面板在右，底部跨滿寬（資訊列、工具列、timeline）。
 *
 * 原本做成左右各一欄，實際用起來檢視區被夾得太窄 —— 比對工具的檢視區是主體，
 * 兩側都放面板等於同時從兩邊擠它。改成全部集中在右側，內部各區塊垂直折疊。
 *
 * 全螢幕是「隱藏面板」而不是瀏覽器的 fullscreen：比對時常要對照別的視窗，
 * 真正的全螢幕反而礙事。
 */

import { useEffect } from 'preact/hooks'
import { toggleSide, transport } from '../app/state'
import {
  exitFullscreen,
  panels,
  setAllSections,
  toggleFullscreen,
  viewerFullscreen,
} from '../app/layout'
import { RightPanelContent } from './RightPanel'
import { SidePanel } from './Panel'
import { BottomBar } from './BottomBar'
import { Viewer } from './Viewer'

export function App() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target
      if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) return
      switch (e.key) {
        case ' ':
          e.preventDefault()
          transport.toggle()
          break
        case 'ArrowLeft':
          e.preventDefault()
          transport.step(-1)
          break
        case 'ArrowRight':
          e.preventDefault()
          transport.step(1)
          break
        case 's':
        case 'S':
          toggleSide()
          break
        case 'Tab':
          e.preventDefault()
          toggleFullscreen()
          break
        case 'Escape':
          exitFullscreen()
          break
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const full = viewerFullscreen.value
  const state = panels.value

  const shellClass = [
    full ? 'fullscreen' : '',
    !full && !state.right ? 'right-collapsed' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div id="shell" class={shellClass || undefined}>
      <main>
        <Viewer />
        {full && (
          <button id="exitFullscreen" onClick={exitFullscreen} title="退出全螢幕（Esc）">
            退出全螢幕
          </button>
        )}
      </main>

      {!full && (
        <SidePanel
          which="right"
          label="面板"
          actions={
            <>
              <button class="link" title="全部展開" onClick={() => setAllSections(true)}>
                ⊕
              </button>
              <button class="link" title="全部折疊" onClick={() => setAllSections(false)}>
                ⊖
              </button>
            </>
          }
        >
          <RightPanelContent />
        </SidePanel>
      )}

      <BottomBar />
    </div>
  )
}
