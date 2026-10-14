export class SearchMetrics {
 readonly values={search_requests_total:0,search_request_duration_ms:{count:0,sum:0,max:0},search_index_events_total:0,search_index_failures_total:0,search_dlq_total:0,search_projection_lag_seconds:0,search_rebuild_duration_seconds:0,search_reconciliation_mismatches_total:0};
 duration(ms:number){const d=this.values.search_request_duration_ms;d.count++;d.sum+=ms;d.max=Math.max(d.max,ms);}
 snapshot(){return structuredClone(this.values);}
}
