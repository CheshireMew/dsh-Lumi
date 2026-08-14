/** Root/subcall Tool composition with one keyed atomic dispatch path. */
import { memo, useMemo, type ReactNode } from 'react'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import type { ToolCallOwnerProps, ToolTreeProps } from '../contract/slots.ts'
import { GenericToolCard } from './toolviews/GenericToolCard.tsx'
import css from './ToolCallTree.module.css'

/** Resolve a Tool call's wire name from either lifecycle form. */
function callName(node: ToolCallBlock): string {
  return 'kind' in node ? node.call?.name ?? '' : node.name
}

/** One atomic call dispatched through the Tool-owned keyed slot. */
const ToolCall = memo(function ToolCall({
  renderSlot, callId, toolName, block, turnSeq, stepSeq, openFile, openDetails, selected, cwd, inspectCall, t, children,
}: Pick<ToolTreeProps, 'renderSlot' | 'openFile' | 'openDetails' | 'cwd' | 'inspectCall' | 't'> & {
  callId: string
  toolName: string
  block: ToolCallBlock
  turnSeq: number
  stepSeq?: number | undefined
  selected: boolean
  children?: ReactNode
}) {
  const owner: ToolCallOwnerProps = useMemo(() => ({
    callId,
    toolName,
    block,
    openFile,
    cwd,
    inspect: () => {
      openDetails?.({ turnSeq, ...(stepSeq === undefined ? {} : { stepSeq }), callId, toolName })
      inspectCall(callId)
    },
  }), [callId, toolName, block, turnSeq, stepSeq, openFile, openDetails, cwd, inspectCall])
  return (
    <div
      className={css.callRow}
      data-chat-anchor-key={`call:${callId}`}
      data-chat-call-id={callId}
      data-selected={selected || undefined}
    >
      {renderSlot('tool.call.toolview', owner, {
        entryKey: toolName,
        fallback: <GenericToolCard {...owner} t={t} />,
      })}
      {children}
    </div>
  )
})

const ToolCallBranch = memo(function ToolCallBranch({
  renderSlot, block, turnSeq, stepSeq, selectedCallId, cwd, openFile, openDetails, inspectCall, t,
}: Pick<ToolTreeProps, 'renderSlot' | 'selectedCallId' | 'cwd' | 'openFile' | 'openDetails' | 'inspectCall' | 't'> & {
  block: ToolCallBlock
  turnSeq: number
  stepSeq?: number | undefined
}) {
  return (
    <ToolCall
      renderSlot={renderSlot}
      callId={block.callId}
      toolName={callName(block)}
      block={block}
      turnSeq={turnSeq}
      stepSeq={stepSeq}
      openFile={openFile}
      openDetails={openDetails}
      selected={block.callId === selectedCallId}
      cwd={cwd}
      inspectCall={inspectCall}
      t={t}
    >
      {block.subCalls.length > 0 ? (
        <div className={css.subCalls} data-subcalls>
          {block.subCalls.map(child => (
            <ToolCallBranch
              key={child.callId}
              renderSlot={renderSlot}
              block={child}
              turnSeq={turnSeq}
              stepSeq={stepSeq}
              selectedCallId={selectedCallId}
              cwd={cwd}
              openFile={openFile}
              openDetails={openDetails}
              inspectCall={inspectCall}
              t={t}
            />
          ))}
        </div>
      ) : null}
    </ToolCall>
  )
})

/**
 * Render one root Tool call and its recursive children through the same
 * atomic keyed dispatch.
 * @param props - whole-Tool owner data and the Tool-owned child-slot share.
 * @returns the Tool call tree.
 */
export function ToolCallTree({
  renderSlot, node, selectedCallId, cwd, openFile, openDetails, inspectCall, t,
}: ToolTreeProps) {
  const block = node.data.root
  const turnSeq = node.location.kind === 'turn' || node.location.kind === 'step'
    ? node.location.turn.turn
    : 0
  const stepSeq = node.location.kind === 'step' ? node.location.step.step : undefined
  return (
    <ToolCallBranch
      renderSlot={renderSlot}
      block={block}
      turnSeq={turnSeq}
      stepSeq={stepSeq}
      selectedCallId={selectedCallId}
      cwd={cwd}
      openFile={openFile}
      openDetails={openDetails}
      inspectCall={inspectCall}
      t={t}
    />
  )
}
