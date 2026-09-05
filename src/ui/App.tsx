/**
 * 版面：左（專案工具）／中（Viewer）／右（參數），底部跨滿寬（資訊列、工具列、timeline）。
 *
 * 參考 Chaos Player 的配置。三個面板都可折疊，Viewer 可進全螢幕模式 ——
 * 全螢幕是「隱藏面板」而不是瀏覽器的 fullscreen：比對時常要對照別的視窗，
 * 真正的全螢幕反而礙事。
 */

import { useEffect } from 'preact/hooks'
import { toggleSide, transport } from '../app/state'
import { exitFullscreen, panels, toggleFullscreen, viewerFullscreen } from '../app/layout'
import { LeftPanelContent } from './LeftPanel'
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
    !full && !state.left ? 'left-collapsed' : '',
    !full && !state.right ? 'right-collapsed' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div id="shell" class={shellClass || undefined}>
      {!full && (
        <SidePanel which="left" label="專案">
          <LeftPanelContent />
        </SidePanel>
      )}

      <main>
        <Viewer />
        {full && (
          <button id="exitFullscreen" onClick={exitFullscreen} title="退出全螢幕（Esc）">
            退出全螢幕
          </button>
        )}
      </main>

      {!full && (
        <SidePanel which="right" label="參數">
          <RightPanelContent />
        </SidePanel>
      )}

      <BottomBar />
    </div>
  )
}
