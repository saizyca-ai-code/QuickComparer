/**
 * 右panel 裡的可折疊區塊。
 *
 * 全部集中到同一欄之後，垂直折疊是必需品而不是裝飾 —— 專案清單、素材槽、
 * 三組參數、除錯面板疊起來遠超過一個螢幕高。
 */

import type { ComponentChildren } from 'preact'
import { isSectionOpen, registerSection, toggleSection } from '../app/layout'

export function Section({
  title,
  children,
}: {
  title: string
  children: ComponentChildren
}) {
  registerSection(title)
  const open = isSectionOpen(title)
  return (
    <section class="section">
      <button class="section-head" onClick={() => toggleSection(title)}>
        <span class="section-caret">{open ? '▾' : '▸'}</span>
        {title}
      </button>
      {open && <div class="section-body">{children}</div>}
    </section>
  )
}
