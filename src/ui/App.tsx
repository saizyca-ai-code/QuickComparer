/** 版面：檢視區 + 傳輸控制列 + 側欄。 */

import { useEffect } from 'preact/hooks'
import { toggleSide, transport } from '../app/state'
import { Sidebar } from './Sidebar'
import { Transport } from './Transport'
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
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  return (
    <>
      <main>
        <Viewer />
        <Transport />
      </main>
      <Sidebar />
    </>
  )
}
