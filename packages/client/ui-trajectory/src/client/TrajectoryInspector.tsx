import {
  IconChevronRightOutline14,
  MarkdownText,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { formatElapsedSeconds } from './trajectory-record.ts'
import {
  clampDetailsWidth,
  defaultToolRequestWidth,
  DETAILS_RESIZE_STEP,
  formatDurationMs,
  KIND_LABEL,
  sectionLabel,
  statusLabel,
  TOOL_REQUEST_SHARE,
} from './trajectory-table-model.tsx'
import {
  isMarkdownRecord,
  MarkdownRecordContent,
  MessageSource,
  messageSourceLabel,
  SystemPromptDiff,
  ToolCatalog,
} from './trajectory-record-content.tsx'
import {
  OverviewSection,
  RecordPayload,
  RecordSchema,
  RecordTiming,
  RequestOptions,
  RequestTiming,
  RequestUsagePanel,
  TokenRows,
  UsageRows,
} from './trajectory-inspector-content.tsx'
import type { useTrajectoryTableModel } from './use-trajectory-table-model.ts'
import css from './TrajectoryTable.module.css'

/**
 * Render the inspector for the selected request or trajectory record.
 * @param props - The trajectory view model shared with the ledger.
 * @returns The inspector when a selection exists.
 */
export function TrajectoryInspector({
  model,
}: {
  model: ReturnType<typeof useTrajectoryTableModel>
}) {
  const {
    activateTab,
    activeTab,
    clearInspectorSelection,
    detailsResizeDrag,
    detailsWidth,
    hasSelectedHierarchy,
    openCallSummary,
    openRecordSummary,
    promptSelected,
    selectRequest,
    selected,
    selectedAssistantRequest,
    selectedAssistantRequestTarget,
    selectedParentMessage,
    selectedParentTool,
    selectedPreviousPrompt,
    selectedPrompt,
    selectedRequest,
    selectedRequestAnchor,
    selectedRequestAssistant,
    selectedRequestCumulativeUsage,
    selectedRequestInfo,
    selectedRequestNumber,
    selectedRequestOptions,
    selectedRequestResult,
    selectedRequestState,
    selectedRequestSubtoolCalls,
    selectedRequestToolCalls,
    selectedRequestUsage,
    selectedState,
    selectedTabs,
    setDetailsWidth,
    setThinkingExpanded,
    setToolRequestOffset,
    thinkingExpanded,
    toolRequestOffset,
  } = model
  return (
    <>
      {(selectedRequest !== null
        || promptSelected
        || (selected !== undefined && selectedState !== undefined)) && (
        <aside
          className={css.details}
          aria-label="Event details"
          style={detailsWidth === null ? undefined : { width: detailsWidth }}
        >
          <div
            className={css.detailsResizeHandle}
            role="separator"
            aria-label="Resize event details"
            aria-controls="trajectory-detail-panel"
            aria-orientation="vertical"
            tabIndex={0}
            title="Drag to resize. Double-click to reset."
            onDoubleClick={() => {
              setDetailsWidth(null)
              setToolRequestOffset(null)
            }}
            onPointerDown={(event) => {
              if (event.button !== 0) return
              const details = event.currentTarget.parentElement
              if (details === null) return
              const split = details.parentElement
              if (split === null) return
              const splitWidth = split.getBoundingClientRect().width
              detailsResizeDrag.current = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startWidth: details.getBoundingClientRect().width,
                splitWidth,
                startToolRequestOffset: toolRequestOffset ?? (
                  splitWidth * TOOL_REQUEST_SHARE - defaultToolRequestWidth(splitWidth)
                ),
              }
              event.currentTarget.setPointerCapture(event.pointerId)
              event.preventDefault()
            }}
            onPointerMove={(event) => {
              const drag = detailsResizeDrag.current
              if (drag === null || drag.pointerId !== event.pointerId) return
              const nextDetailsWidth = clampDetailsWidth(
                drag.startWidth + drag.startX - event.clientX,
                drag.splitWidth,
              )
              setDetailsWidth(nextDetailsWidth)
              setToolRequestOffset(
                drag.startToolRequestOffset
                + (nextDetailsWidth - drag.startWidth) * TOOL_REQUEST_SHARE,
              )
            }}
            onPointerUp={(event) => {
              if (detailsResizeDrag.current?.pointerId !== event.pointerId) return
              detailsResizeDrag.current = null
              event.currentTarget.releasePointerCapture(event.pointerId)
            }}
            onPointerCancel={() => {
              detailsResizeDrag.current = null
            }}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
              const details = event.currentTarget.parentElement
              if (details === null) return
              const split = details.parentElement
              if (split === null) return
              const direction = event.key === 'ArrowLeft' ? 1 : -1
              const currentDetailsWidth = details.getBoundingClientRect().width
              const splitWidth = split.getBoundingClientRect().width
              const nextDetailsWidth = clampDetailsWidth(
                currentDetailsWidth + direction * DETAILS_RESIZE_STEP,
                splitWidth,
              )
              const currentToolRequestOffset = toolRequestOffset ?? (
                splitWidth * TOOL_REQUEST_SHARE - defaultToolRequestWidth(splitWidth)
              )
              setDetailsWidth(nextDetailsWidth)
              setToolRequestOffset(
                currentToolRequestOffset
                + (nextDetailsWidth - currentDetailsWidth) * TOOL_REQUEST_SHARE,
              )
              event.preventDefault()
            }}
          />
          <div className={css.detailsHeader}>
            <div className={css.detailsTitle}>
              {selectedRequest !== null
                ? (
                  <>
                    <span className={css.requestDetailsDot} aria-hidden="true" />
                    <span className={css.requestDetailsName}>
                      Request #{selectedRequestNumber ?? '—'}
                    </span>
                    <span className={css.detailsLocation}>
                      {selectedRequestInfo?.purpose === 'compaction'
                        ? `Compaction · ${sectionLabel(selectedRequest.turn)}`
                        : sectionLabel(selectedRequest.turn)}
                    </span>
                  </>
                )
                : promptSelected
                  ? (
                    <>
                      <span className={`${css.kindTag} ${css.systemNeutral}`}>SYSTEM</span>
                      <span className={css.detailsLocation}>{selected?.cell.text}</span>
                    </>
                  )
                  : selected !== undefined && (
                    <>
                      <span className={`${css.kindTag} ${
                        selected.cell.kind === 'context'
                          ? css.contextGreen
                          : selected.cell.kind === 'compacted'
                            ? css.compacted
                            : selected.cell.kind === 'tool'
                              ? css.toolAmber
                              : selected.cell.kind === 'message'
                                ? css.assistantVioletBright
                                : selected.cell.kind === 'subtool'
                                  ? css.subtoolAmber
                                  : css[selected.cell.kind]
                      }`}
                      >
                        {KIND_LABEL[selected.cell.kind]}
                      </span>
                      <span className={css.detailsLocation}>
                        {selected.cell.kind === 'compacted'
                          ? sectionLabel(selected.turn)
                          : `${sectionLabel(selected.turn)} · ${selected.group}`}
                      </span>
                    </>
                  )}
            </div>
            <button
              type="button"
              className={css.close}
              aria-label="Close details"
              onClick={clearInspectorSelection}
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
          <div className={css.detailTabs} role="tablist" aria-label="Event details">
            {selectedTabs.map(tab => (
              <button
                key={tab.id}
                id={`trajectory-detail-${tab.id}`}
                type="button"
                role="tab"
                aria-controls="trajectory-detail-panel"
                aria-selected={activeTab === tab.id}
                className={activeTab === tab.id ? `${css.detailTab} ${css.detailTabActive}` : css.detailTab}
                onClick={() => { activateTab(tab.id) }}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div
            id="trajectory-detail-panel"
            className={activeTab === 'overview'
              ? `${css.detailBody} ${css.detailBodySummary}`
              : css.detailBody}
            role="tabpanel"
            aria-labelledby={`trajectory-detail-${activeTab}`}
          >
            {selectedRequest !== null
              && selectedRequestState !== undefined
              && activeTab === 'overview' && (
              <>
                <dl
                  className={`${css.overview} ${css.summaryScrollRegion}`}
                  data-summary-scroll-region=""
                >
                  <div>
                    <dt>Status</dt>
                    <dd className={selectedRequestState === 'error' ? css.error : undefined}>
                      {statusLabel(selectedRequestState)}
                    </dd>
                  </div>
                  {selectedRequestInfo?.purpose === 'compaction' && (
                    <div>
                      <dt>Purpose</dt>
                      <dd>Compaction</dd>
                    </div>
                  )}
                  {(selectedRequestInfo?.provider
                    ?? selectedRequestInfo?.requestConfig?.provider) !== undefined && (
                    <div>
                      <dt>Provider</dt>
                      <dd>
                        {selectedRequestInfo?.provider
                          ?? selectedRequestInfo?.requestConfig?.provider}
                      </dd>
                    </div>
                  )}
                  {(selectedRequestInfo?.model
                    ?? selectedRequestInfo?.requestConfig?.model) !== undefined && (
                    <div>
                      <dt>Model</dt>
                      <dd>
                        {selectedRequestInfo?.model
                          ?? selectedRequestInfo?.requestConfig?.model}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt>Tool calls</dt>
                    <dd>{selectedRequestToolCalls}</dd>
                  </div>
                  {selectedRequestSubtoolCalls > 0 && (
                    <div>
                      <dt>Subtool calls</dt>
                      <dd>{selectedRequestSubtoolCalls}</dd>
                    </div>
                  )}
                  {selectedRequestInfo?.error !== undefined && (
                    <div>
                      <dt>Error</dt>
                      <dd className={css.error}>{selectedRequestInfo.error}</dd>
                    </div>
                  )}
                  {selectedRequestInfo?.retry !== undefined && (
                    <div>
                      <dt>Retry</dt>
                      <dd>
                        Scheduled {selectedRequestInfo.retry}
                        {selectedRequestInfo.maxRetries === undefined
                          ? ''
                          : ` of ${selectedRequestInfo.maxRetries}`}
                      </dd>
                    </div>
                  )}
                  {selectedRequestInfo?.retryDelayMs !== undefined && (
                    <div>
                      <dt>Retry delay</dt>
                      <dd>{formatDurationMs(selectedRequestInfo.retryDelayMs)}</dd>
                    </div>
                  )}
                  {selectedRequestResult !== undefined && (
                    <div>
                      <dt>Result</dt>
                      <dd className={css.overviewParentLinks}>
                        <button
                          type="button"
                          className={css.overviewHierarchyNavLink}
                          onClick={() => {
                            openRecordSummary(selectedRequestResult)
                          }}
                        >
                          <span>
                            {selectedRequestInfo?.purpose === 'compaction'
                              ? 'Compacted'
                              : 'Assistant Message'}
                          </span>
                          <IconChevronRightOutline14
                            className={css.overviewHierarchyJumpIconTight}
                            size={11}
                          />
                        </button>
                      </dd>
                    </div>
                  )}
                </dl>
                <div className={css.overviewSections}>
                  {selectedRequestOptions !== undefined && (
                    <OverviewSection label="Options" onOpen={() => { activateTab('options') }}>
                      <RequestOptions options={selectedRequestOptions} preview />
                    </OverviewSection>
                  )}
                  <OverviewSection label="Usage" onOpen={() => { activateTab('usage') }}>
                    <UsageRows usage={selectedRequestUsage} />
                  </OverviewSection>
                  <OverviewSection label="Timing" onOpen={() => { activateTab('timing') }}>
                    <RequestTiming
                      assistant={selectedRequestAssistant}
                      anchor={selectedRequestAnchor}
                      request={selectedRequestInfo}
                    />
                  </OverviewSection>
                </div>
              </>
            )}
            {selectedRequest !== null && activeTab === 'options' && (
              <RequestOptions options={selectedRequestOptions} />
            )}
            {selectedRequest !== null && activeTab === 'usage' && (
              <RequestUsagePanel
                usage={selectedRequestUsage}
                cumulative={selectedRequestCumulativeUsage}
              />
            )}
            {selectedRequest !== null && activeTab === 'timing' && (
              <RequestTiming
                assistant={selectedRequestAssistant}
                anchor={selectedRequestAnchor}
                request={selectedRequestInfo}
              />
            )}
            {promptSelected
              && selectedPrompt !== undefined
              && selectedPreviousPrompt !== undefined
              && activeTab === 'diff' && (
              <SystemPromptDiff
                before={selectedPreviousPrompt}
                after={selectedPrompt}
              />
            )}
            {promptSelected && selectedPrompt !== undefined && activeTab === 'system-prompt' && (
              selectedPrompt.system === ''
                ? <p className={css.noPayload}>No system prompt in this request</p>
                : (
                  <div className={`${css.markdownPayload} ${css.systemPrompt}`}>
                    <MarkdownText text={selectedPrompt.system} />
                  </div>
                )
            )}
            {promptSelected && selectedPrompt !== undefined && activeTab === 'tools' && (
              <ToolCatalog tools={selectedPrompt.tools} />
            )}
            {!promptSelected
              && selected?.cell.kind === 'compacted'
              && selectedState !== undefined
              && activeTab === 'overview' && (
              <>
                <dl
                  className={`${css.overview} ${css.summaryScrollRegion}`}
                  data-summary-scroll-region=""
                >
                  <div>
                    <dt>Status</dt>
                    <dd className={selectedState === 'error' ? css.error : undefined}>
                      {statusLabel(selectedState)}
                    </dd>
                  </div>
                  <div>
                    <dt>Duration</dt>
                    <dd>{formatElapsedSeconds(selected.cell.timeSeconds)}</dd>
                  </div>
                  <div>
                    <dt>Tokens</dt>
                    <dd>—</dd>
                  </div>
                </dl>
                {selected.cell.outputDetail !== undefined && (
                  <div
                    className={`${css.compactedSummary} ${css.summaryScrollRegion}`}
                    data-summary-scroll-region=""
                  >
                    <MarkdownRecordContent
                      record={selected}
                      rendered
                      thinkingExpanded={thinkingExpanded}
                      onThinkingExpandedChange={setThinkingExpanded}
                      onOpenCall={openCallSummary}
                    />
                  </div>
                )}
              </>
            )}
            {!promptSelected
              && selected !== undefined
              && selected.cell.kind !== 'compacted'
              && selectedState !== undefined
              && activeTab === 'overview' && (
              <>
                <dl
                  className={`${css.overview} ${css.summaryScrollRegion}`}
                  data-summary-scroll-region=""
                >
                  {selected.cell.messageSource !== undefined && (
                    <div>
                      <dt>Source</dt>
                      <dd className={css.overviewParentLinks}>
                        <button
                          type="button"
                          className={css.overviewHierarchyNavLink}
                          onClick={() => { activateTab('source') }}
                        >
                          <span>{messageSourceLabel(selected.cell.messageSource)}</span>
                          <IconChevronRightOutline14
                            className={css.overviewHierarchyJumpIconTight}
                            size={11}
                          />
                        </button>
                      </dd>
                    </div>
                  )}
                  {hasSelectedHierarchy && (
                    <div>
                      <dt>
                        {selectedAssistantRequestTarget !== undefined
                          ? 'Source'
                          : 'Hierarchy'}
                      </dt>
                      <dd className={css.overviewParentLinks}>
                        {selectedAssistantRequestTarget !== undefined && (
                          <button
                            type="button"
                            className={css.overviewHierarchyNavLink}
                            onClick={() => {
                              selectRequest(selectedAssistantRequestTarget)
                            }}
                          >
                            <span>Request #{selectedAssistantRequest ?? '—'}</span>
                            <IconChevronRightOutline14
                              className={css.overviewHierarchyJumpIconTight}
                              size={11}
                            />
                          </button>
                        )}
                        {selectedParentMessage !== undefined && (
                          <button
                            type="button"
                            className={css.overviewHierarchyNavLink}
                            onClick={() => { openRecordSummary(selectedParentMessage) }}
                          >
                            <span>Assistant Message</span>
                            <IconChevronRightOutline14
                              className={css.overviewHierarchyJumpIconTight}
                              size={11}
                            />
                          </button>
                        )}
                        {selectedParentTool !== undefined && (
                          <button
                            type="button"
                            className={css.overviewHierarchyNavLink}
                            onClick={() => { openRecordSummary(selectedParentTool) }}
                          >
                            <span>Tool Call</span>
                            <IconChevronRightOutline14
                              className={css.overviewHierarchyJumpIconTight}
                              size={11}
                            />
                          </button>
                        )}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt>Status</dt>
                    <dd className={selectedState === 'error' ? css.error : undefined}>
                      {statusLabel(selectedState)}
                    </dd>
                  </div>
                  {selected.cell.kind === 'message' && (
                    <TokenRows cell={selected.cell} />
                  )}
                  {(selected.cell.kind === 'user' || selected.cell.kind === 'context') && (
                    <div>
                      <dt>Duration</dt>
                      <dd>{formatElapsedSeconds(selected.cell.timeSeconds)}</dd>
                    </div>
                  )}
                </dl>
                <div className={css.overviewSections}>
                  {isMarkdownRecord(selected)
                    ? (
                      <>
                        <OverviewSection label="Preview" onOpen={() => { activateTab('rendered') }}>
                          <MarkdownRecordContent
                            record={selected}
                            rendered
                            preview
                            thinkingExpanded={thinkingExpanded}
                            onThinkingExpandedChange={setThinkingExpanded}
                            onOpenCall={openCallSummary}
                          />
                        </OverviewSection>
                      </>
                    )
                    : (
                      <>
                        {selected.cell.inputDetail && (
                          <OverviewSection label="Payload" onOpen={() => { activateTab('input') }}>
                            <RecordPayload record={selected} direction="input" preview />
                          </OverviewSection>
                        )}
                        {selected.cell.outputDetail && (
                          <OverviewSection label="Result" onOpen={() => { activateTab('output') }}>
                            <RecordPayload record={selected} direction="output" preview />
                          </OverviewSection>
                        )}
                        <OverviewSection label="Schema" onOpen={() => { activateTab('schema') }}>
                          <RecordSchema record={selected} preview />
                        </OverviewSection>
                      </>
                    )}
                  {selectedAssistantRequestTarget !== undefined && (
                    <OverviewSection
                      label="Request Timing"
                      onOpen={() => {
                        selectRequest(selectedAssistantRequestTarget, 'timing')
                      }}
                    >
                      <RecordTiming record={selected} />
                    </OverviewSection>
                  )}
                  {(selected.cell.kind === 'tool' || selected.cell.kind === 'subtool') && (
                    <OverviewSection label="Timing" onOpen={() => { activateTab('timing') }}>
                      <RecordTiming record={selected} />
                    </OverviewSection>
                  )}
                </div>
              </>
            )}
            {!promptSelected && selected !== undefined && activeTab === 'rendered' && (
              <MarkdownRecordContent
                record={selected}
                rendered
                thinkingExpanded={thinkingExpanded}
                onThinkingExpandedChange={setThinkingExpanded}
                onOpenCall={openCallSummary}
              />
            )}
            {!promptSelected && selected !== undefined && activeTab === 'raw' && (
              <MarkdownRecordContent
                record={selected}
                rendered={false}
                thinkingExpanded={thinkingExpanded}
                onThinkingExpandedChange={setThinkingExpanded}
                onOpenCall={openCallSummary}
              />
            )}
            {!promptSelected && selected !== undefined && activeTab === 'source' && (
              <MessageSource record={selected} />
            )}
            {!promptSelected && selected !== undefined && activeTab === 'input' && (
              <RecordPayload record={selected} direction="input" />
            )}
            {!promptSelected && selected !== undefined && activeTab === 'output' && (
              <RecordPayload record={selected} direction="output" />
            )}
            {!promptSelected && selected !== undefined && activeTab === 'schema' && (
              <RecordSchema record={selected} />
            )}
            {!promptSelected && selected !== undefined && activeTab === 'timing' && (
              <RecordTiming record={selected} />
            )}
          </div>
        </aside>
      )}
    </>
  )
}
