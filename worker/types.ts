export type PlaceKind = 'activity' | 'parking' | 'elevator';
export interface Place {
  id: string;
  name: string;
  kind: PlaceKind;
  anchor: { x: number; y: number };
  /** Full 24576-square GIS image coordinates normalized to [0,1]. */
  gis_anchor?: { x: number; y: number; verified: boolean };
  coverage: 'unconfigured';
}

export interface Observation {
  id: string;
  place_id: string;
  kind: 'parking' | 'elevator';
  source: 'manual';
  status: 'active' | 'cancelled';
  observed_at: string;
  valid_until: string;
  parking_min: number | null;
  parking_max: number | null;
  wait_seconds: number | null;
}

export interface PlaceSummary {
  place: Place;
  sensor: null;
  latest_observation: Observation | null;
  freshness: 'no_data' | 'fresh' | 'stale';
  as_of: string;
}

export interface CreateObservation {
  id: string;
  place_id: string;
  kind: 'parking' | 'elevator';
  observed_at: string;
  parking_min?: number;
  parking_max?: number;
  wait_seconds?: number;
}

// Generated binding types follow wrangler.jsonc. Production may intentionally
// omit raw storage; tests and API-only environments can omit Static Assets.
export interface Env extends Pick<WorkerBindings, 'DB'> {
  ASSETS?: WorkerBindings['ASSETS'];
  OPERATOR_TOKEN?: string;
  RAW_BUCKET?: WorkerBindings['RAW_BUCKET'];
  RESEARCH_TOKEN?: string;
  /** Bootstrap/cookie-signing secret; token login is disabled after account setup. */
  ADMIN_TOKEN?: string;
  /** Exact trusted HTTPS origin and hostname RP ID; localhost is development-only. */
  ADMIN_WEBAUTHN_ORIGIN?: string;
  ADMIN_WEBAUTHN_RP_ID?: string;
}
