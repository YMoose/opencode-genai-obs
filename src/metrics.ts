/**
 * @fileoverview GenAI-semconv metrics — exactly two instruments, per the project scope:
 * gen_ai.client.token.usage and gen_ai.client.operation.duration. The span state machine
 * (spans.ts) is the only data source; it reports observations through MetricObservation
 * and stays SDK-free — this module is the only place that touches @opentelemetry/sdk-metrics.
 *
 * No global MeterProvider: a private provider + PeriodicExportingMetricReader keeps the
 * signal off the process-global registry (co-hosted plugins must not observe our meter).
 */
import { resourceFromAttributes } from "@opentelemetry/resources"
import { MeterProvider } from "@opentelemetry/sdk-metrics"
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto"
import type { Attributes } from "@opentelemetry/api"

/** One metric observation reported by the span state machine */
export type MetricObservation =
  | {
      readonly metric: "token"
      /** input includes cache read/write (billable input, same aggregation as the chat span) */
      readonly tokenType: "input" | "output"
      readonly value: number
      readonly provider: string
      readonly model: string
    }
  | {
      readonly metric: "duration"
      /** chat | execute_tool */
      readonly operation: string
      readonly durationNano: bigint
      readonly provider?: string
      readonly model?: string
      readonly tool?: string
      readonly errorType?: string
    }

export interface MetricsOptions {
  /** Base URL; /v1/metrics is appended here */
  readonly endpoint: string
  /** Extra request headers (auth etc.) */
  readonly headers?: Record<string, string>
  /** Custom attributes merged into the OTLP resource block (builtin keys win) */
  readonly resourceAttributes?: Record<string, string>
  /** Export interval in ms, default 60s */
  readonly intervalMs?: number
}

export interface Metrics {
  readonly observe: (obs: MetricObservation) => void
  /** Export whatever is buffered, then release the exporter (called on plugin unload) */
  readonly shutdown: () => Promise<void>
}

export function createMetrics(options: MetricsOptions): Metrics {
  const resource = resourceFromAttributes({
    ...Object.fromEntries(
      Object.entries(options.resourceAttributes ?? {}).filter(([key]) => key !== "service.name"),
    ),
    "service.name": "opencode-genai-obs",
  })

  const exporter = new OTLPMetricExporter({
    url: `${options.endpoint.replace(/\/+$/, "")}/v1/metrics`,
    headers: options.headers,
  })
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: options.intervalMs ?? 60_000,
  })
  const provider = new MeterProvider({ resource, readers: [reader] })
  const meter = provider.getMeter("opencode-genai-obs", "0.1.0")

  const tokenUsage = meter.createHistogram("gen_ai.client.token.usage", {
    description: "Number of input/output tokens per GenAI operation",
    unit: "{token}",
  })
  const operationDuration = meter.createHistogram("gen_ai.client.operation.duration", {
    description: "GenAI operation duration",
    unit: "s",
  })

  return {
    observe(obs) {
      if (obs.metric === "token") {
        const attrs: Attributes = {
          "gen_ai.provider.name": obs.provider,
          "gen_ai.request.model": obs.model,
          "gen_ai.token.type": obs.tokenType,
        }
        tokenUsage.record(obs.value, attrs)
        return
      }
      const attrs: Attributes = { "gen_ai.operation.name": obs.operation }
      if (obs.provider !== undefined) attrs["gen_ai.provider.name"] = obs.provider
      if (obs.model !== undefined) attrs["gen_ai.request.model"] = obs.model
      if (obs.tool !== undefined) attrs["gen_ai.tool.name"] = obs.tool
      if (obs.errorType !== undefined) attrs["error.type"] = obs.errorType
      operationDuration.record(Number(obs.durationNano) / 1e9, attrs)
    },
    async shutdown() {
      await provider.shutdown() // flushes the reader (final export), then shuts the exporter down
    },
  }
}
