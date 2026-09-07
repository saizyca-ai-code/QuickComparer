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
  /** 放在標題列上的額外動作，收合時一併隱藏。 */
  actions?: ComponentChildren
  children: ComponentChildren
}

export function SidePanel({ which, label, actions, children }: Props) {
  const open = panels.value[which]

  if (!open) {
    return (
      <div class="panel-rail rail-right">
        <button class="link rail-toggle" title={`展開${label}`} onClick={() => togglePanel(which)}>
          ◂
        </button>
        <span class="rail-label">{label}</span>
      </div>
    )
  }

  return (
    <aside class="panel panel-right">
      <div class="panel-head">
        <span>{label}</span>
        <span class="panel-head-actions">
          {actions}
          <button class="link" title={`收合${label}`} onClick={() => togglePanel(which)}>
            ▸
          </button>
        </span>
      </div>
      <div class="panel-body">{children}</div>
    </aside>
  )
}
