/**
 * OpenTelemetry instrumentation bootstrap.
 *
 * Must be imported BEFORE any application code so the SDK can patch
 * Node.js built-ins and third-party libraries at load time.
 *
 * Usage (src/main.ts):
 *   import './tracing.js';
 *
 * Environment variables:
 *   OTEL_SERVICE_NAME        - service name in traces (default: bridgelet-sdk)
 *   OTEL_EXPORTER_OTLP_ENDPOINT - collector endpoint (default: http://localhost:4317)
 *   OTEL_ENABLED             - set to 'false' to disable (default: enabled)
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';

// #730: these OTEL_* reads are deliberately NOT routed through ConfigService.
// This module runs before the Nest container exists (it must patch libraries at
// load time), so there is no ConfigService to inject yet. Everything else reads
// configuration via the typed namespaces in src/config/.
const enabled = process.env.OTEL_ENABLED !== 'false';

let sdk: NodeSDK | null = null;

if (enabled) {
  sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'bridgelet-sdk',
    traceExporter: new OTLPTraceExporter({
      url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4317',
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Suppress noisy fs instrumentation
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  sdk.start();

  process.on('SIGTERM', () => {
    void (async () => {
      try {
        await sdk?.shutdown();
      } finally {
        process.exit(0);
      }
    })();
  });
}

export { sdk };
