import type {SpanExporter} from '@opentelemetry/sdk-trace-base';
import type {MetricReader} from '@opentelemetry/sdk-metrics';
export interface TelemetryState {enabled:boolean;serviceName?:string;shutdown():Promise<void>;flush():Promise<void>}
export function initializeTelemetry(env?:NodeJS.ProcessEnv,overrides?:{spanExporter?:SpanExporter;metricReader?:MetricReader}):Promise<TelemetryState>;
