// @vitest-environment jsdom
// Assembled session-lifecycle snapshot: boots the built client plugin graph,
// archives the resident fixture session through the transport, opens its
// dedicated archive row, and pins the permanent-delete rejection surface.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { installAssembledBootEnv, mountAssembledApp, REFRESHING_GOLDEN } from './assembled-boot.ts'

const EXPECTED = join(process.cwd(), 'apps/web/tests/snapshots/session-lifecycle/archive-delete.expected.txt')

installAssembledBootEnv()

describe('assembled session lifecycle', () => {
  it('renders the archive actions and preserves a rejected permanent-delete confirmation', async () => {
    mountAssembledApp()

    const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
    const title = 'Fixture 历史会话'
    const sessionTitle = await within(tree).findByText(title)
    const sessionRow = sessionTitle.closest<HTMLElement>('[role="treeitem"]')
    if (sessionRow === null) throw new Error('fixture session title must belong to a tree row')
    const sessionAction = sessionRow.querySelector<HTMLButtonElement>(`button[aria-label="Session actions for ${title}"]`)
    if (sessionAction === null) throw new Error('fixture session row must expose its actions button')

    fireEvent.click(sessionAction)
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive session' }))

    const archivedLabel = await within(tree).findByText('Archived')
    const archivedGroup = archivedLabel.closest<HTMLElement>('[role="treeitem"]')
    if (archivedGroup === null) throw new Error('archive label must belong to a tree row')
    if (archivedGroup.getAttribute('aria-expanded') === 'false') fireEvent.click(archivedLabel)

    const archivedTitle = await within(tree).findByText(title)
    const archivedRow = archivedTitle.closest<HTMLElement>('[role="treeitem"]')
    if (archivedRow === null) throw new Error('archived session title must belong to a tree row')
    const archivedAction = archivedRow.querySelector<HTMLButtonElement>(`button[aria-label="Session actions for ${title}"]`)
    if (archivedAction === null) throw new Error('archived session row must expose its actions button')
    fireEvent.click(archivedAction)

    const restore = await screen.findByRole('menuitem', { name: 'Restore session' })
    const remove = screen.getByRole('menuitem', { name: 'Delete session permanently' })
    const menuText = [restore.textContent?.trim(), remove.textContent?.trim()]
    fireEvent.click(remove)

    const dialog = await screen.findByRole('dialog', { name: 'Delete session permanently' })
    const description = within(dialog).getByText(
      `This permanently deletes “${title}” and every descendant session log. This cannot be undone.`,
    )
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' })
    const confirm = within(dialog).getByRole('button', { name: 'Delete session permanently' })
    fireEvent.click(confirm)

    const alert = await within(dialog).findByRole('alert')
    await waitFor(() => { expect(screen.getByRole('dialog', { name: 'Delete session permanently' })).toBe(dialog) })

    const shape = [
      `group=${archivedLabel.textContent?.trim()}`,
      `session=${archivedTitle.textContent?.trim()}`,
      ...menuText.map(item => `menu=${item}`),
      `dialog=${within(dialog).getByRole('heading').textContent?.trim()}`,
      `description=${description.textContent?.trim()}`,
      `button=${cancel.textContent?.trim()}`,
      `button=${confirm.textContent?.trim()}`,
      `error=${alert.textContent?.trim()}`,
      `dialog-preserved=${document.body.contains(dialog)}`,
    ].join('\n') + '\n'
    if (REFRESHING_GOLDEN) {
      mkdirSync(dirname(EXPECTED), { recursive: true })
      writeFileSync(EXPECTED, shape)
    }
    await expect(shape).toMatchFileSnapshot(EXPECTED)
  })
})
