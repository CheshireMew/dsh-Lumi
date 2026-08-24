import type { ReactNode } from 'react'
import {
  IconChevronRightOutline14,
  JsonTree,
  MarkdownText,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AssistantRequestConfig } from '@deepseek-ai/dsh-client-runtime/client'
import type { TrajectoryCellProps } from './trajectory-record.ts'
import { formatElapsedSeconds } from './trajectory-record.ts'
import {
  AssistantTimingPanel,
  StartedAtValue,
  type TableRecord,
  type TrajectoryRequestNumber,
  type TrajectoryUsage,
} from './trajectory-table-model.tsx'
import { ToolOutputBlocks } from './trajectory-record-content.tsx'
import css from './TrajectoryTable.module.css'

export function TokenRows({ cell }: { cell: TrajectoryCellProps }) {
  const content = cell.output !== undefined && cell.think !== undefined
    ? Math.max(0, cell.output - cell.think)
    : undefined
  return (
    <>
      <div>
        <dt>Tokens</dt>
        <dd>{cell.output === undefined ? '—' : `${cell.output} tok`}</dd>
      </div>
      {cell.think !== undefined && (
        <div className={css.requestTokenDetail}>
          <dt>Reasoning</dt>
          <dd>{cell.think} tok</dd>
        </div>
      )}
      {content !== undefined && (
        <div className={css.requestTokenDetail}>
          <dt>Content</dt>
          <dd>{content} tok</dd>
        </div>
      )}
    </>
  )
}

function inputTotal(usage: TrajectoryUsage): number | undefined {
  if (
    usage.input === undefined
    && usage.cacheRead === undefined
    && usage.cacheWrite === undefined
  ) return undefined
  return (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
}

export function UsageRows({ usage }: { usage: TrajectoryUsage | undefined }) {
  if (usage === undefined) return <p className={css.noPayload}>Usage not reported</p>
  const totalInput = inputTotal(usage)
  const otherOutput = usage.output !== undefined && usage.reasoning !== undefined
    ? usage.output - usage.reasoning
    : undefined
  return (
    <dl className={css.overview}>
      {totalInput !== undefined && (
        <div><dt>Input</dt><dd>{totalInput} tok</dd></div>
      )}
      {usage.cacheRead !== undefined && (
        <div className={css.requestTokenDetail}>
          <dt>Cached</dt>
          <dd>{usage.cacheRead} tok</dd>
        </div>
      )}
      {usage.cacheWrite !== undefined && (
        <div className={css.requestTokenDetail}>
          <dt>Cache created</dt>
          <dd>{usage.cacheWrite} tok</dd>
        </div>
      )}
      {usage.input !== undefined && (
        <div className={css.requestTokenDetail}>
          <dt>Other</dt>
          <dd>{usage.input} tok</dd>
        </div>
      )}
      {usage.output !== undefined && (
        <div><dt>Output</dt><dd>{usage.output} tok</dd></div>
      )}
      {usage.reasoning !== undefined && (
        <div className={css.requestTokenDetail}>
          <dt>Reasoning</dt>
          <dd>{usage.reasoning} tok</dd>
        </div>
      )}
      {otherOutput !== undefined && (
        <div className={css.requestTokenDetail}>
          <dt>Content</dt>
          <dd>{otherOutput} tok</dd>
        </div>
      )}
    </dl>
  )
}

export function RequestUsagePanel({
  usage,
  cumulative,
}: {
  usage: TrajectoryUsage | undefined
  cumulative: TrajectoryUsage | undefined
}) {
  return (
    <div className={css.usagePanel}>
      <section className={css.usageGroup}>
        <h4 className={css.usageHeading}>This request</h4>
        <UsageRows usage={usage} />
      </section>
      <section className={css.usageGroup}>
        <h4 className={css.usageHeading}>Session cumulative</h4>
        <UsageRows usage={cumulative} />
      </section>
    </div>
  )
}

export function RequestOptions({
  options,
  preview = false,
}: {
  options: AssistantRequestConfig | undefined
  preview?: boolean
}) {
  if (options === undefined) {
    return <p className={css.noPayload}>Options not recorded</p>
  }
  return (
    <JsonTree
      data={options}
      label="Request options JSON"
      className={preview ? css.jsonPreview : css.jsonPayload}
    />
  )
}

export function RecordTiming({ record }: { record: TableRecord }) {
  return record.cell.kind === 'message' && record.cell.assistantMetrics !== undefined
    ? <AssistantTimingPanel metrics={record.cell.assistantMetrics} />
    : (
      <dl className={css.overview}>
        <div><dt>Started</dt><StartedAtValue timestamp={record.cell.startedAt ?? null} /></div>
        <div><dt>Duration</dt><dd>{formatElapsedSeconds(record.cell.timeSeconds)}</dd></div>
        <div><dt>Timing source</dt><dd>{record.cell.timeSeconds === null ? 'Not available' : 'Session timestamps'}</dd></div>
      </dl>
    )
}

export function RequestTiming({
  assistant,
  anchor,
  request,
}: {
  assistant: TableRecord | undefined
  anchor: TableRecord | undefined
  request: TrajectoryRequestNumber | undefined
}) {
  if (assistant !== undefined) return <RecordTiming record={assistant} />
  if (request?.startedAt !== undefined) {
    const duration = request.completedAt === null || request.completedAt === undefined
      ? null
      : Math.max(0, (request.completedAt - request.startedAt) / 1000)
    return (
      <dl className={css.overview}>
        <div><dt>Started</dt><StartedAtValue timestamp={request.startedAt} /></div>
        <div><dt>Duration</dt><dd>{formatElapsedSeconds(duration)}</dd></div>
        <div>
          <dt>Timing source</dt>
          <dd>{duration === null ? 'Session timestamps (running)' : 'Session timestamps'}</dd>
        </div>
      </dl>
    )
  }
  return (
    <dl className={css.overview}>
      <div>
        <dt>Started</dt>
        <StartedAtValue timestamp={anchor?.cell.startedAt ?? null} />
      </div>
      <div><dt>Duration</dt><dd>{formatElapsedSeconds(null)}</dd></div>
    </dl>
  )
}

export function RecordPayload({
  record,
  direction,
  preview = false,
}: {
  record: TableRecord
  direction: 'input' | 'output'
  preview?: boolean
}) {
  const value = direction === 'input' ? record.cell.inputDetail : record.cell.outputDetail
  const missing = direction === 'input'
    ? 'No payload captured'
    : 'No result captured'
  if (!value) return <p className={css.noPayload}>{missing}</p>
  const error = direction === 'output' && record.cell.isError === true
  const payloadClass = preview ? css.jsonPreview : css.jsonPayload
  const payloadClassName = error ? `${payloadClass} ${css.errorPayload}` : payloadClass

  const json = parseJsonContainer(value)
  const singleTextResult = direction === 'output'
    && record.cell.outputBlocks?.length === 1
    && record.cell.outputBlocks[0]?.type === 'text'
  if (singleTextResult && json !== undefined) {
    return (
      <JsonTree
        data={json}
        label="Result JSON"
        className={payloadClassName}
      />
    )
  }

  if (
    direction === 'output'
    && record.cell.outputBlocks?.some(block =>
      block.imageSrc !== undefined || block.content !== '') === true
  ) {
    return (
      <ToolOutputBlocks
        blocks={record.cell.outputBlocks}
        error={error}
        preview={preview}
      />
    )
  }

  const markdown = (
    direction === 'input'
    && (record.cell.kind === 'user' || record.cell.kind === 'context')
  ) || (
    direction === 'output' && record.cell.kind === 'message'
  )
  if (markdown) {
    return (
      <div className={[
        preview ? css.markdownPreview : css.markdownPayload,
        error ? css.errorPayload : undefined,
      ].filter((className): className is string => className !== undefined).join(' ')}
      >
        <MarkdownText text={value} />
      </div>
    )
  }
  if (json !== undefined) {
    return (
      <JsonTree
        data={json}
        label={`${direction === 'input' ? 'Payload' : 'Result'} JSON`}
        className={payloadClassName}
      />
    )
  }
  return (
    <pre className={[
      css.payload,
      preview ? css.payloadPreview : undefined,
      error ? css.errorPayload : undefined,
      value === 'No output' ? css.noOutputText : undefined,
    ].filter((value): value is string => value !== undefined).join(' ')}
    >
      {value}
    </pre>
  )
}

export function RecordSchema({
  record,
  preview = false,
}: {
  record: TableRecord
  preview?: boolean
}) {
  if (!record.cell.schemaDetail) {
    return <p className={css.noPayload}>Schema unavailable</p>
  }
  const schema = parseToolSchema(record.cell.schemaDetail)
  if (schema !== undefined) {
    return (
      <div className={preview ? `${css.schema} ${css.schemaPreview}` : css.schema}>
        <header className={css.schemaIntro}>
          <h3 className={css.schemaName}>{schema.name}</h3>
          <p className={css.schemaDescription}>{schema.description}</p>
        </header>
        <section className={css.schemaParameters}>
          <h4 className={css.schemaParametersTitle}>Parameters</h4>
          <JsonTree
            data={schema.parameters}
            label={`${schema.name} parameters JSON`}
            className={css.schemaTree}
          />
        </section>
      </div>
    )
  }
  return (
    <pre className={`${css.payload} ${preview ? css.payloadPreview : ''}`}>
      {record.cell.schemaDetail}
    </pre>
  )
}

interface ParsedToolSchema {
  name: string
  description: string
  parameters: object
}

function parseToolSchema(value: string): ParsedToolSchema | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const schema = parsed as Record<string, unknown>
    if (
      typeof schema.name !== 'string'
      || typeof schema.description !== 'string'
      || typeof schema.parameters !== 'object'
      || schema.parameters === null
      || Array.isArray(schema.parameters)
    ) return undefined
    return {
      name: schema.name,
      description: schema.description,
      parameters: schema.parameters,
    }
  } catch {
    return undefined
  }
}

function parseJsonContainer(value: string): object | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

export function OverviewSection({
  label,
  onOpen,
  children,
}: {
  label: string
  onOpen: () => void
  children: ReactNode
}) {
  return (
    <section className={css.overviewSection}>
      <h3 className={css.overviewHeading}>
        <button
          type="button"
          className={css.overviewTitle}
          onClick={onOpen}
        >
          <span>{label}</span>
          <IconChevronRightOutline14 className={css.overviewTitleIcon} size={12} />
        </button>
      </h3>
      <div
        className={`${css.overviewPreview} ${css.summaryScrollRegion}`}
        data-summary-scroll-region=""
      >
        {children}
      </div>
    </section>
  )
}
