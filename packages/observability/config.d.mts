export interface EnabledConfig {enabled:true;serviceName:string;endpoint:string;sampleRatio:number;queueSize:number;batchSize:number;exportTimeoutMs:number;intervalMs:number;shutdownMs:number;logLevel:'error'}
export type ObservabilityConfig=EnabledConfig|{enabled:false};
export function loadObservabilityConfig(env?:NodeJS.ProcessEnv):ObservabilityConfig;
