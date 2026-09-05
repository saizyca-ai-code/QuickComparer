/**
 * 可折疊面板的外殼。
 *
 * 折疊後保留一條窄邊條與展開鈕 —— 收起來就完全消失的話，使用者找不回來，
 * 只能靠選單或快捷鍵，而那是要記的東西。
 */

import type { ComponentChildren } from 'preact'
import { panels, togglePanel, type PanelState } from '../app/layout'

interface Props {
  which: keyof PanelState
  /** 收合時顯示在窄邊條上的文字。 */
  label: string
  children: ComponentChildren
}

export function SidePanel({ which, label, children }: Props) {
  const open = panels.value[which]
  const side = which === 'left' ? 'left' : 'right'

  if (!open) {
    return (
      <div class={`panel-rail rail-${side}`}>
        <button
          class="link rail-toggle"
          title={`展開${label}`}
          onClick={() => togglePanel(which)}
        >
          {side === 'left' ? '▸' : '◂'}
        </button>
        <span class="rail-label">{label}</span>
      </div>
    )
  }

  return (
    <aside class={`panel panel-${side}`}>
      <div class="panel-head">
        <span>{label}</span>
        <button
          class="link"
          title={`收合${label}`}
          onClick={() => togglePanel(which)}
        >
          {side === 'left' ? '◂' : '▸'}
        </button>
      </div>
      <div class="panel-body">{children}</div>
    </aside>
  )
}
