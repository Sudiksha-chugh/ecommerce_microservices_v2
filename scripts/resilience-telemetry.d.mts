import type {TelemetryEvidence} from '../packages/resilience-testing/src/telemetry.js';
export interface ScenarioLifecycle {activate():void;remove():void;recovering():void}
export interface ScenarioCapture {scenarioId:string;status:'passed'|'failed';telemetry:TelemetryEvidence}
export function createScenarioTelemetry():Promise<{record<T>(id:string,fault:string,target:string,action:(lifecycle:ScenarioLifecycle)=>Promise<T>):Promise<{result:T;telemetry:TelemetryEvidence}>;evidence:ScenarioCapture[];shutdown():Promise<void>}>;
