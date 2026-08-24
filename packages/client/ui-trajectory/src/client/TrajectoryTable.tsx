/** Turn-aware trajectory event ledger with a local record inspector. */

import {
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { trajectoryRecordId } from './trajectory-record.ts'
import { trajectoryVirtualRecordKey } from './trajectory-virtual-rows.ts'
import css from './TrajectoryTable.module.css'
import {
  assistantToolCalls,
  BOTTOM_FOLLOW_THRESHOLD_PX,
  KIND_ICON,
  KIND_LABEL,
  requestKey,
  sectionLabel,
  stateOf,
  type RequestBoundaryStyle,
  type TrajectoryTableProps,
  type VirtualSpacerStyle,
} from './trajectory-table-model.tsx'
export type {
  TrajectoryRequestNumber,
  TrajectoryTableProps,
  TrajectoryUsage,
} from './trajectory-table-model.tsx'

import {
  RecordListText,
  RecordPresentation,
} from './trajectory-record-content.tsx'
import { useTrajectoryTableModel } from './use-trajectory-table-model.ts'
import { TrajectoryInspector } from './TrajectoryInspector.tsx'

/**
 * Render trajectory events as a dense ledger with turn and step separators.
 * Clicking ledger whitespace clears the active record or request selection.
 * @param props - Grouped trajectory data and whole-ledger fold state.
 * @returns The ledger and an optional local record inspector.
 */
export function TrajectoryTable(props: TrajectoryTableProps) {
  const model = useTrajectoryTableModel(props)
  const {
    activeSection,
    activeTurn,
    allRecords,
    clearAllSelections,
    collapsedTurns,
    followsTableTail,
    hasOlderRecords,
    historyRowOffset,
    olderBusy,
    onLoadOlder,
    onToggleAssistant,
    onToggleTurn,
    records,
    renderedRecords,
    requestBoundaries,
    requestBoundaryRuns,
    requestNumbers,
    requestOlder,
    rootRef,
    selectRecord,
    selectRequest,
    selectedIndex,
    selectedRequest,
    sessionRequestNumbers,
    showInitialLoading,
    splitStyle,
    tablePaneRef,
    tableScrollReady,
    timelineFocusIndexes,
    virtualBottom,
    virtualTop,
    virtualizationEnabled,
  } = model
  return (
    <div ref={rootRef} className={css.split} style={splitStyle}>
      <div
        ref={tablePaneRef}
        className={css.tablePane}
        data-trajectory-scroll=""
        onScroll={(event) => {
          const pane = event.currentTarget
          followsTableTail.current =
            pane.scrollHeight - pane.clientHeight - pane.scrollTop
              <= BOTTOM_FOLLOW_THRESHOLD_PX
          requestOlder(pane, true)
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) clearAllSelections()
        }}
      >
        {showInitialLoading && (
          <div className={css.historyLoading} role="status" aria-live="polite">
            <span className={css.historyLoadingBar}>
              <span className={css.historyLoadingSpinner} aria-hidden="true" />
              Loading trajectory…
            </span>
          </div>
        )}
        <table
          className={css.table}
          data-scroll-ready={tableScrollReady || undefined}
          aria-rowcount={records.length + historyRowOffset}
        >
          <colgroup>
            <col className={css.eventColumn} />
            <col className={css.contentColumn} />
          </colgroup>
          <tbody>
            {hasOlderRecords && (
              <tr
                className={css.historyLoadRow}
                data-history-load=""
                aria-rowindex={1}
              >
                <td colSpan={2}>
                  <button
                    type="button"
                    className={css.historyLoadButton}
                    disabled={olderBusy || onLoadOlder === undefined}
                    aria-label={olderBusy
                      ? 'Loading earlier history…'
                      : 'Load earlier history'}
                    onClick={() => {
                      const pane = tablePaneRef.current
                      if (pane !== null) requestOlder(pane, false)
                    }}
                  >
                    {olderBusy && (
                      <span className={css.historyLoadingSpinner} aria-hidden="true" />
                    )}
                    <span aria-hidden="true">
                      {olderBusy ? 'Loading earlier history…' : 'Load earlier history'}
                    </span>
                    <span className={css.visuallyHidden} role="status" aria-live="polite">
                      {olderBusy ? 'Loading earlier history…' : ''}
                    </span>
                  </button>
                </td>
              </tr>
            )}
            {virtualTop > 0 && (
              <tr className={css.virtualSpacer} data-virtual-spacer="top" aria-hidden="true">
                <td
                  colSpan={2}
                  style={{
                    '--trajectory-virtual-spacer-height': `${virtualTop}px`,
                  } as VirtualSpacerStyle}
                />
              </tr>
            )}
            {renderedRecords.map(({ record, position, terminalRequestBoundary }) => (
              <RecordPresentation
                key={trajectoryVirtualRecordKey(record)}
                cell={record.cell}
              >
                {({ displayText, listDisplayText, resultText, toolCallOnly, toolCallText }) => {
                  const isCollapsedSummary = record.collapsedSummary !== undefined
                  const isRequestOnly = record.cell.requestOnly === true
                  const isInitialSystem = record.cell.kind === 'system'
                && record.cell.index === allRecords[0]?.cell.index
                  const key = requestKey(record.turn, record.group)
                  const request = requestBoundaries.get(key) === record.cell.index
                && !isCollapsedSummary
                && (record.turn === null || !collapsedTurns.has(record.turn))
                    ? requestNumbers.get(key)
                    : undefined
                  const requestInfo = request === undefined
                    ? undefined
                    : sessionRequestNumbers?.find(candidate => candidate.number === request)
                  const requestStatus = requestInfo?.status
                ?? (record.cell.isError === true ? 'error' : undefined)
                  const requestRunIndex = requestBoundaryRuns.get(record.cell.index) ?? 0
                  const requestBoundaryStyle: RequestBoundaryStyle = {
                    '--request-boundary-offset': `${requestRunIndex * 8}px`,
                  }
                  const requestLabel = request === undefined
                    ? undefined
                    : `Request #${request}${requestInfo?.purpose === 'compaction' ? ' · Compaction' : ''}`
                  const requestSelected = request !== undefined
                && selectedRequest?.turn === record.turn
                && selectedRequest.group === record.group
                  const sectionActive = record.turn === null
                    ? activeSection === record.section
                    : activeTurn === record.turn
                  return (
                    <tr
                      tabIndex={isRequestOnly ? -1 : 0}
                      aria-rowindex={position + 1 + historyRowOffset}
                      aria-label={isCollapsedSummary
                        ? `Collapsed ${record.collapsedSummaryKind} summary, ${record.collapsedSummary}`
                        : isRequestOnly
                          ? `Request ${request ?? ''}, compaction`
                          : `${request === undefined ? '' : `Request ${request}, `}${KIND_LABEL[record.cell.kind]}, ${listDisplayText || 'no content'}`}
                      aria-selected={!isCollapsedSummary && !isRequestOnly && selectedIndex === record.cell.index}
                      data-kind={record.cell.kind}
                      data-trajectory-row-key={trajectoryVirtualRecordKey(record)}
                      data-virtual-position={virtualizationEnabled ? position : undefined}
                      data-record-index={!isCollapsedSummary && !isRequestOnly
                        ? record.cell.index
                        : undefined}
                      data-request-only={isRequestOnly || undefined}
                      data-terminal-request-boundary={terminalRequestBoundary || undefined}
                      data-group-start={record.groupStart || undefined}
                      data-turn-start={record.turnStart || undefined}
                      data-error={record.cell.isError || undefined}
                      data-running={stateOf(record) === 'running' || undefined}
                      data-turn-end={record.turnEnd || undefined}
                      data-collapsed-summary={record.collapsedSummaryKind}
                      data-selected={!isCollapsedSummary && selectedIndex === record.cell.index || undefined}
                      data-timeline-focus={isCollapsedSummary || timelineFocusIndexes === null
                        ? undefined
                        : timelineFocusIndexes.has(record.cell.index) ? 'inside' : 'outside'}
                      onClick={isRequestOnly
                        ? undefined
                        : isCollapsedSummary
                          ? () => {
                            if (record.collapsedSummaryKind === 'turn' && record.turn !== null) {
                              onToggleTurn(record.turn)
                            } else onToggleAssistant(trajectoryRecordId(record.cell))
                          }
                          : () => { selectRecord(record.cell.index) }}
                      onDoubleClick={(event) => {
                        if (isCollapsedSummary || isRequestOnly) return
                        if (record.turn !== null && collapsedTurns.has(record.turn)) {
                          event.preventDefault()
                          onToggleTurn(record.turn)
                          return
                        }
                        if (
                          record.cell.kind === 'message'
                      && assistantToolCalls(allRecords, record.cell.index).length > 0
                        ) {
                          event.preventDefault()
                          onToggleAssistant(trajectoryRecordId(record.cell))
                          return
                        }
                        if (!record.turnStart) return
                        if (record.turn === null) return
                        if (allRecords.filter(candidate =>
                          candidate.turn === record.turn
                      && candidate.cell.requestOnly !== true
                      && candidate.cell.kind !== 'system').length <= 1) return
                        event.preventDefault()
                        onToggleTurn(record.turn)
                      }}
                      onKeyDown={(event) => {
                        if (isRequestOnly) return
                        if (event.key !== 'Enter' && event.key !== ' ') return
                        event.preventDefault()
                        if (isCollapsedSummary) {
                          if (record.collapsedSummaryKind === 'turn' && record.turn !== null) {
                            onToggleTurn(record.turn)
                          } else onToggleAssistant(trajectoryRecordId(record.cell))
                          return
                        }
                        selectRecord(record.cell.index)
                      }}
                    >
                      <td className={css.event}>
                        {request !== undefined && (
                          <button
                            type="button"
                            className={requestSelected
                              ? `${css.requestBoundaryControl} ${css.requestBoundaryControlActive}`
                              : css.requestBoundaryControl}
                            aria-label={requestLabel}
                            aria-pressed={requestSelected}
                            data-label={requestLabel}
                            data-request-run-index={requestRunIndex}
                            data-request-status={requestStatus}
                            style={requestBoundaryStyle}
                            onClick={(event) => {
                              event.stopPropagation()
                              selectRequest({
                                turn: record.turn,
                                group: record.group,
                                ...(requestInfo?.seq === undefined ? {} : { seq: requestInfo.seq }),
                              })
                            }}
                            onDoubleClick={(event) => { event.stopPropagation() }}
                          />
                        )}
                        {record.turn !== null
                    && activeTurn === record.turn
                    && !isInitialSystem && (
                          <span className={css.turnRail} aria-hidden="true" />
                        )}
                        {!isCollapsedSummary && selectedIndex === record.cell.index && (
                          <span className={css.selectionRail} aria-hidden="true" />
                        )}
                        {!isCollapsedSummary
                    && !isRequestOnly
                    && record.turnStart && (
                          <span
                            className={sectionActive
                              ? `${css.turnLabel} ${css.turnLabelActive}`
                              : css.turnLabel}
                            aria-label={sectionLabel(record.turn)}
                          >
                            {record.turn === null
                              ? sectionLabel(record.turn)
                              : (
                                <>
                                  <span className={css.turnLabelFull} aria-hidden="true">
                                    {sectionLabel(record.turn)}
                                  </span>
                                  <span className={css.turnLabelCompact} aria-hidden="true">
                                    #{record.turn}
                                  </span>
                                </>
                              )}
                          </span>
                        )}
                        <div className={css.eventInner}>
                          {!isCollapsedSummary && !isRequestOnly && (
                            <span
                              className={css.kindSlot}
                            >
                              <span
                                className={`${css.kindTag} ${
                                  record.cell.kind === 'system'
                                    ? css.systemNeutral
                                    : record.cell.kind === 'context'
                                      ? css.contextGreen
                                      : record.cell.kind === 'compacted'
                                        ? css.compacted
                                        : record.cell.kind === 'tool'
                                          ? css.toolAmber
                                          : record.cell.kind === 'message'
                                            ? css.assistantVioletBright
                                            : record.cell.kind === 'subtool'
                                              ? css.subtoolAmber
                                              : css[record.cell.kind]
                                }`}
                                data-role-kind={record.cell.kind}
                              >
                                <Tooltip
                                  label={KIND_LABEL[record.cell.kind]}
                                  side="right"
                                >
                                  <span className={css.kindTagIcon} aria-hidden="true">
                                    {KIND_ICON[record.cell.kind]}
                                  </span>
                                </Tooltip>
                                <span className={css.kindTagLabel}>
                                  {KIND_LABEL[record.cell.kind]}
                                </span>
                              </span>
                            </span>
                          )}
                        </div>
                      </td>
                      <td className={css.content}>
                        {isRequestOnly
                          ? null
                          : record.collapsedSummary !== undefined
                            ? (
                              <span className={css.collapsedTurnContent} title={record.collapsedSummary}>
                                <span className={css.collapsedTurnEllipsis}>…</span>
                                <span className={css.collapsedTurnText}>{record.collapsedSummary}</span>
                              </span>
                            )
                            : (
                              <span
                                className={resultText === undefined ? css.contentText : css.resultPreview}
                                title={resultText === undefined
                                  ? listDisplayText
                                  : `${listDisplayText} → ${resultText}`}
                              >
                                <span className={resultText === undefined ? undefined : css.resultRequest}>
                                  <RecordListText
                                    displayText={displayText}
                                    toolCallOnly={toolCallOnly}
                                    toolCallText={toolCallText}
                                  />
                                </span>
                                {resultText !== undefined && (
                                  <span className={record.cell.isError ? `${css.inlineResult} ${css.error}` : css.inlineResult}>
                                    <span className={css.arrow}>→</span>
                                    <span className={resultText === 'No output'
                                      ? `${css.inlineResultText} ${css.noOutputText}`
                                      : css.inlineResultText}
                                    >
                                      {resultText}
                                    </span>
                                  </span>
                                )}
                              </span>
                            )}
                      </td>
                    </tr>
                  )
                }}
              </RecordPresentation>
            ))}
            {virtualBottom > 0 && (
              <tr className={css.virtualSpacer} data-virtual-spacer="bottom" aria-hidden="true">
                <td
                  colSpan={2}
                  style={{
                    '--trajectory-virtual-spacer-height': `${virtualBottom}px`,
                  } as VirtualSpacerStyle}
                />
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <TrajectoryInspector model={model} />
    </div>
  )
}
