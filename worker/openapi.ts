import { addDeviceV3OpenApi } from './device-v3-openapi';
import { createAdminOpenApi } from './admin-openapi';

/** Implemented public, operator, administrator, device and research API contract. */
export function createOpenApiDocument(): Record<string, unknown> {
  const admin = createAdminOpenApi();
  // Generate examples per document request so Try it out does not reuse a stale
  // timestamp or a shared observation ID. These are illustrative values only.
  const observedAt = new Date().toISOString();
  const parkingExample = {
    id: crypto.randomUUID(), place_id: 'east-parking', kind: 'parking',
    observed_at: observedAt, parking_min: 4, parking_max: 7,
  };
  const elevatorExample = {
    id: crypto.randomUUID(), place_id: 'teaching-elevator', kind: 'elevator',
    observed_at: observedAt, wait_seconds: 45,
  };
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const responseHeaders = {
    'Cache-Control': { description: 'API responses are not cached.', schema: { type: 'string', const: 'no-store' } },
    'X-Content-Type-Options': { schema: { type: 'string', const: 'nosniff' } },
  };
  const response = (description: string, schema: Record<string, unknown>) => ({
    description, headers: responseHeaders, content: { 'application/json': { schema } },
  });
  const error = (description: string, codes: string[], retryable = false) => response(description, {
    type: 'object', additionalProperties: false, required: ['error'],
    properties: {
      error: {
        type: 'object', additionalProperties: false, required: ['code', 'message', 'retryable'],
        properties: {
          code: { type: 'string', enum: codes }, message: { type: 'string' },
          retryable: { type: 'boolean', const: retryable },
        },
      },
    },
  });
  const storageUnavailable = error('Storage or another runtime dependency is unavailable.', ['storage_unavailable'], true);
  const writeErrors = {
    '401': error('Missing or incorrect operator bearer credential.', ['unauthorized']),
    '403': error('The supplied Origin differs from the request URL origin.', ['origin_rejected']),
    '503': error('The operator secret is not configured, or storage/runtime is unavailable.', ['operator_not_configured', 'storage_unavailable'], true),
  };
  const placeIdParameter = {
    name: 'id', in: 'path', required: true, description: 'Registered logical place ID.',
    schema: ref('PlaceId'), example: 'east-parking',
  };
  const uuid = {
    type: 'string', format: 'uuid',
    pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
  };
  const timestamp = { type: 'string', format: 'date-time' };
  const observedTimestamp = {
    ...timestamp, pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
    description: 'Canonical ISO UTC with exactly three fractional digits. Must be within the past 24 hours and at most 30 seconds ahead of server time when submitted.',
  };
  const createBase = {
    id: { ...uuid, description: 'Fresh client-generated UUIDv4; retry the exact same content with this ID after an uncertain result.' },
    place_id: ref('PlaceId'), observed_at: observedTimestamp,
  };
  const parkingValue = { type: 'integer', minimum: 0, maximum: 10000 };
  const waitValue = { type: 'integer', minimum: 0, maximum: 7200 };
  const count = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
  const seq = { type: 'integer', minimum: 1, maximum: 0xffffffff };
  const nullableCount = { type: ['integer', 'null'], minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
  const label = { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' };
  const hex64 = { type: 'string', pattern: '^[0-9a-f]{64}$', minLength: 64, maxLength: 64 };
  const document = {
    openapi: '3.1.0',
    info: {
      title: 'CampusPulse API', version: '0.3.0',
      description: 'Public place reads, operator manual observations, administrator sessions, native V3 device control and statistics. Production transport is MQTT/TLS through the authenticated gateway. V1/V2 device routes are retired; business /api/v1 routes remain independent. Historical source data is retained. Device claims and committed receipts do not establish radio completeness.',
    },
    servers: [{ url: '/' }],
    security: [],
    tags: [
      ...admin.tags,
      { name: 'Public reads', description: 'No authentication required. No data must not be interpreted as zero people or vehicles.' },
      { name: 'Operator writes', description: 'A shared opaque operator bearer secret, not a JWT or user account. All holders can create and cancel any manual record; there is no per-user ownership. A supplied Origin must match the request origin; absent Origin is allowed. No operator secret is published in this document.' },
      { name: 'Device ingestion', description: 'A registered, enabled node credential grants only its node and capture policies. The token is distinct from operator and researcher access. Batch bytes, body hash, config, stream and dataset must agree.' },
      { name: 'Private research', description: 'Independent researcher bearer token. Raw batches contain observed addresses and advertisement bytes; never expose them through public reads or caches.' },
    ],
    paths: {
      ...admin.paths,
      '/api/v1/health': {
        get: {
          operationId: 'getHealth', tags: ['Public reads'], summary: 'Check runtime liveness',
          description: 'Reports Worker liveness and whether a private R2 binding is configured. Does not probe D1/R2 availability or validate any device.',
          responses: { '200': response('Worker is responding.', ref('Health')) },
        },
      },
      '/api/v1/places': {
        get: {
          operationId: 'listPlaces', tags: ['Public reads'], summary: 'List registered places',
          description: 'Places are ordered by ID. Schematic anchors are provisional; GIS anchors are included only where configured. The place coverage field reflects configuration, not a count of people.',
          responses: { '200': response('Registered places.', ref('Places')), '503': storageUnavailable },
        },
      },
      '/api/v1/places/{id}/summary': {
        get: {
          operationId: 'getPlaceSummary', tags: ['Public reads'], summary: 'Get latest manual and field sensor summaries',
          description: 'Sensor is the latest retained field window from the past 24 hours with known UTC and uncertainty <=30 seconds. The entire interval [window start minus uncertainty, window end plus uncertainty] must fit the immutable placement. Only an empty flag list or the documented non-clock quality allowlist is public; unknown flags are withheld. Its valid_until is window UTC minus uncertainty plus 90 seconds. When sensor is null, optional last_reported_sensor separately exposes a retained aggregate with unknown or unreliable clock, ordered by exact server receipt. The exact receipt must fall inside its original immutable placement interval (start inclusive, closure exclusive), and its registered capture config must match that placement. Original closed placements remain eligible; records received at or after closure are withheld and never move to a successor placement. Receipt time is never substituted for observation time. This fallback has unverified freshness and no validity deadline; it never enters history, replay or inference, or affects top-level freshness. Top-level freshness is fresh when the canonical sensor window or any latest active manual purpose result is fresh, stale when at least one exists but none is fresh, and no_data otherwise. Each manual purpose retains its own expiry. No sensor means null, never zero people.',
          parameters: [placeIdParameter],
          responses: {
            '200': response('Latest manual and field sensor summaries, including explicit missing-data state.', ref('PlaceSummary')),
            '404': error('The place is not registered.', ['place_not_found']), '503': storageUnavailable,
          },
        },
      },
      '/api/v1/places/{id}/history': {
        get: {
          operationId: 'getPlaceHistory', tags: ['Public reads'], summary: 'Get recent manual observations and field sensor windows',
          description: 'Manual records use the inclusive [from, to] window and at most 200 items; truncated applies to them. sensor_windows contains at most 200 retained field windows with known UTC, uncertainty <=30 seconds, only flags in the documented public allowlist, and a full uncertainty interval inside its placement; sensor_truncated applies to that list. Sensor count is BLE-visible identifiers, not people. Accepted minutes values are exact strings.',
          parameters: [placeIdParameter, {
            name: 'minutes', in: 'query', required: false,
            schema: { type: 'string', enum: ['1', '5', '15', '60', '1440'], default: '15' },
            description: 'History window in minutes; defaults to 15.',
          }],
          responses: {
            '200': response('Bounded manual and field sensor history.', ref('PlaceHistory')),
            '404': error('The place is not registered.', ['place_not_found']),
            '422': error('Unsupported minutes value.', ['invalid_range']), '503': storageUnavailable,
          },
        },
      },
      '/api/v1/observations': {
        post: {
          operationId: 'createObservation', tags: ['Operator writes'], summary: 'Commit a manual observation',
          description: 'Requires application/json (charset parameters are accepted), no Content-Encoding header, and a body no larger than 8192 bytes (8 KiB). Unknown fields, null numeric values, mixed parking/elevator fields and non-integer values are rejected. Parking minimum must not exceed maximum, and kind must be enabled in the registered place observation_kinds. valid_until is observed_at plus the configured observation TTL (15 minutes by default), not reception time; settings changes do not rewrite existing records; an accepted old observation may already be stale. New insertion returns 201; an identical ID/content retry returns 200, including the current cancelled status if already cancelled, or a purpose disabled since the original write. Changed content for an existing ID returns 409. Relative timestamp validation is repeated on retries, so retries older than 24 hours are rejected. Confirmation follows the D1 write. Replace the synthetic examples with actual measurements: Try it out creates real records.',
          security: [{ OperatorToken: [] }],
          requestBody: {
            required: true,
            content: { 'application/json': {
              schema: ref('CreateObservation'),
              examples: {
                parking: { summary: 'Synthetic parking example — replace with an actual observation', value: parkingExample },
                elevator: { summary: 'Synthetic elevator example — replace with an actual measurement', value: elevatorExample },
              },
            } },
            'x-max-body-bytes': 8192,
          },
          responses: {
            '200': response('Identical ID/content retry; the existing record is returned without reactivation.', ref('ObservationReceipt')),
            '201': response('New observation committed.', ref('ObservationReceipt')),
            '400': error('Missing, invalid JSON or invalid UTF-8 body.', ['invalid_json']),
            ...writeErrors,
            '404': error('The place is not registered.', ['place_not_found']),
            '409': error('The observation ID already has different content.', ['observation_conflict']),
            '413': error('The request body exceeds 8192 bytes.', ['payload_too_large']),
            '415': error('Content-Type must be application/json and Content-Encoding must be absent.', ['content_type', 'content_encoding']),
            '422': error('Observation validation failed.', ['invalid_observation', 'unknown_field', 'invalid_identity', 'invalid_time', 'invalid_parking', 'invalid_wait', 'invalid_kind', 'place_kind_mismatch']),
          },
        },
      },
      '/api/v1/observations/{id}': {
        delete: {
          operationId: 'cancelObservation', tags: ['Operator writes'], summary: 'Cancel a manual observation',
          description: 'Idempotently sets status to cancelled and returns the stored record after the D1 write. Any holder of the shared operator secret can cancel any record. Cancelled records disappear from summary/history; repeating DELETE returns 200. Cancellation does not delete the record. To correct a record, cancel it and submit a fresh UUIDv4. The implemented route matches 36 lowercase hexadecimal/hyphen characters; IDs created by the examples use that form.',
          security: [{ OperatorToken: [] }],
          parameters: [{
            name: 'id', in: 'path', required: true, description: 'Existing observation ID (normally a lowercase UUIDv4).',
            schema: { type: 'string', minLength: 36, maxLength: 36, pattern: '^[0-9a-f-]{36}$' },
          }],
          responses: {
            '200': response('Cancellation committed, including an already-cancelled record.', ref('ObservationReceipt')),
            ...writeErrors,
            '404': error('The observation does not exist.', ['observation_not_found']),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        ...admin.securitySchemes,
        OperatorToken: {
          type: 'http', scheme: 'bearer',
          description: 'Opaque shared operator secret, not a JWT. Enter only the token in Authorize; the client sends Authorization: Bearer <token>. This operator credential has no login, expiry or per-user record ownership; administrator sessions use a separate credential. When the secret is unconfigured, writes return 503.',
        },
        DeviceToken: { type: 'http', scheme: 'bearer', description: 'Registered node credential; enter token only. It is checked against the node registry and permits only its node and registered capture policy.' },
        ResearchToken: { type: 'http', scheme: 'bearer', description: 'Independent private research token; enter token only. It does not authorize device writes or operator observations.' },
      },
      schemas: {
        ...admin.schemas,
        PlaceId: { type: 'string', pattern: '^[a-z0-9_-]{1,64}$', minLength: 1, maxLength: 64 },
        Health: {
          type: 'object', additionalProperties: false, required: ['status', 'ingestion', 'raw_storage'],
          properties: { status: { type: 'string', const: 'ok' }, ingestion: { type: 'string', const: 'implemented' },
            raw_storage: { type: 'string', enum: ['configured', 'unconfigured'] } },
        },
        Anchor: {
          type: 'object', additionalProperties: false, required: ['x', 'y'],
          properties: { x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 } },
        },
        GisAnchor: {
          type: 'object', additionalProperties: false, required: ['x', 'y', 'verified'],
          properties: { x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 }, verified: { type: 'boolean', const: true } },
        },
        Place: {
          type: 'object', additionalProperties: false, required: ['id', 'name', 'kind', 'observation_kinds', 'anchor', 'coverage'],
          properties: {
            id: ref('PlaceId'), name: { type: 'string' }, kind: { type: 'string', enum: ['activity', 'parking', 'elevator'] },
            observation_kinds: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true, items: { type: 'string', enum: ['activity', 'parking', 'elevator'] }, description: 'Concurrent enabled purposes at this physical place; kind remains the legacy primary purpose.' },
            anchor: ref('Anchor'), gis_anchor: ref('GisAnchor'), coverage: { type: 'string', const: 'unconfigured' },
          },
        },
        Places: {
          type: 'object', additionalProperties: false, required: ['places'],
          properties: { places: { type: 'array', items: ref('Place') } },
        },
        CreateParkingObservation: {
          type: 'object', additionalProperties: false,
          required: ['id', 'place_id', 'kind', 'observed_at', 'parking_min', 'parking_max'],
          properties: { ...createBase, kind: { type: 'string', const: 'parking' }, parking_min: parkingValue, parking_max: parkingValue },
          description: 'Manual parking range; parking_min must be <= parking_max. wait_seconds and all unknown fields are prohibited.',
        },
        CreateElevatorObservation: {
          type: 'object', additionalProperties: false,
          required: ['id', 'place_id', 'kind', 'observed_at', 'wait_seconds'],
          properties: { ...createBase, kind: { type: 'string', const: 'elevator' }, wait_seconds: waitValue },
          description: 'Measured elevator wait in seconds. Both parking fields and all unknown fields are prohibited.',
        },
        CreateObservation: {
          oneOf: [ref('CreateParkingObservation'), ref('CreateElevatorObservation')],
          discriminator: { propertyName: 'kind', mapping: { parking: '#/components/schemas/CreateParkingObservation', elevator: '#/components/schemas/CreateElevatorObservation' } },
        },
        Observation: {
          type: 'object', additionalProperties: false,
          required: ['id', 'place_id', 'kind', 'source', 'status', 'observed_at', 'valid_until', 'parking_min', 'parking_max', 'wait_seconds'],
          properties: {
            id: uuid, place_id: ref('PlaceId'), kind: { type: 'string', enum: ['parking', 'elevator'] },
            source: { type: 'string', const: 'manual' }, status: { type: 'string', enum: ['active', 'cancelled'] },
            observed_at: timestamp, valid_until: { ...timestamp, description: 'observed_at plus the site observation TTL at insertion; 15 minutes by default. Historical records keep their original deadline.' },
            parking_min: { ...parkingValue, type: ['integer', 'null'] },
            parking_max: { ...parkingValue, type: ['integer', 'null'] },
            wait_seconds: { ...waitValue, type: ['integer', 'null'] },
          },
          oneOf: [
            { properties: { kind: { const: 'parking' }, parking_min: parkingValue, parking_max: parkingValue, wait_seconds: { type: 'null' } } },
            { properties: { kind: { const: 'elevator' }, parking_min: { type: 'null' }, parking_max: { type: 'null' }, wait_seconds: waitValue } },
          ],
        },
        ObservationReceipt: {
          type: 'object', additionalProperties: false, required: ['observation', 'durability'],
          properties: { observation: ref('Observation'), durability: { type: 'string', const: 'committed' } },
        },
        PlaceSummary: {
          type: 'object', additionalProperties: false, required: ['place', 'sensor', 'latest_observation', 'latest_observations', 'freshness', 'as_of'],
          properties: {
            place: ref('Place'), sensor: { oneOf: [ref('PublicSensorWindow'), { type: 'null' }] },
            last_reported_sensor: { type: 'null', description: 'V3 requires provable source time; receipt time never substitutes for observation time.' },
            latest_observation: { oneOf: [ref('Observation'), { type: 'null' }] },
            latest_observations: { type: 'object', additionalProperties: false, required: ['parking', 'elevator'], properties: {
              parking: { oneOf: [ref('Observation'), { type: 'null' }] }, elevator: { oneOf: [ref('Observation'), { type: 'null' }] },
            }, description: 'Latest active record independently per manual purpose, including retained history after a purpose is disabled. Each record keeps its own valid_until; sensor windows remain shared observations and do not predict people or vehicles.' },
            automatic_observations: ref('AutomaticObservations'),
            freshness: { type: 'string', enum: ['no_data', 'fresh', 'stale'] }, as_of: timestamp,
          },
        },
        AutomaticObservations: {
          type: 'object', additionalProperties: false, required: ['vehicles', 'elevator'],
          properties: { vehicles: ref('AutomaticVehicleObservation'), elevator: ref('AutomaticElevatorObservation') },
          description: 'Optional additive live analysis. Source timestamps and expiry are independent of manual/sensor freshness. No addresses, names or private feature masks are public. Current analysis is not archived into replay.',
        },
        AutomaticVehicleObservation: {
          type: 'object', additionalProperties: false,
          required: ['status','source','model_version','observed_at','valid_until','candidate_count','car_related_count','ecosystem_count','sample_count','reason','quality_flags','evidence_kind'],
          properties: {
            status: { type: 'string', enum: ['candidate_estimate','unavailable'] }, source: { type: 'string', const: 'ble_rule_inference' },
            model_version: { type: 'string' }, observed_at: { oneOf: [timestamp, { type: 'null' }] }, valid_until: { oneOf: [timestamp, { type: 'null' }] },
            candidate_count: nullableCount, car_related_count: nullableCount, ecosystem_count: nullableCount, sample_count: count,
            reason: { type: ['string','null'] }, quality_flags: { type: 'array', maxItems: 32, items: { type: 'string' } },
            evidence_kind: { type: 'string', enum: ['compact','raw','none'] },
          },
          description: 'V3 aggregate classification is unavailable under the current unclassified-v1 ruleset. Unknown evidence keeps counts null. Independent manual observations remain available.',
        },
        AutomaticElevatorObservation: {
          type: 'object', additionalProperties: false,
          required: ['status','source','model_version','wait_seconds','range_seconds','sample_count','day_count','observed_at','valid_until','reason','calibrated'],
          properties: {
            status: { type: 'string', enum: ['historical_estimate','unavailable'] }, source: { type: 'string', const: 'manual_historical_baseline' },
            model_version: { type: 'string' }, wait_seconds: { type: ['number','null'], minimum: 0, maximum: 7200 },
            range_seconds: { oneOf: [{ type: 'object', additionalProperties: false, required: ['lower','upper'], properties: { lower: { type: 'number', minimum: 0, maximum: 7200 }, upper: { type: 'number', minimum: 0, maximum: 7200 } } }, { type: 'null' }] },
            sample_count: count, day_count: count, observed_at: { oneOf: [timestamp, { type: 'null' }] }, valid_until: { oneOf: [timestamp, { type: 'null' }] },
            reason: { type: ['string','null'] }, calibrated: { type: 'boolean', const: false },
          },
          description: 'Uncalibrated median and empirical p20/p80 range of comparable completed manual waits from the last 14 days. Engineering gates require at least five records on two local dates, matched by local hour and weekday/weekend. This is a historical reference, not a measured current wait, boarding detection or guaranteed prediction interval. Insufficient evidence leaves seconds and range null.',
        },
        PlaceHistory: {
          type: 'object', additionalProperties: false, required: ['place_id', 'observations', 'sensor_windows', 'from', 'to', 'truncated', 'sensor_truncated'],
          properties: {
            place_id: ref('PlaceId'), observations: { type: 'array', maxItems: 200, items: ref('Observation') },
            sensor_windows: { type: 'array', maxItems: 200, items: ref('PublicSensorWindow') },
            from: timestamp, to: timestamp, truncated: { type: 'boolean' }, sensor_truncated: { type: 'boolean' },
          },
        },
        PublicSensorWindow: {
          type: 'object', additionalProperties: false,
          required: ['node_id','boot_id','placement_id','protocol','policy_id','assignment_generation','source','dataset','seq','observed_at','valid_until','uncertainty_ms','duration_ms','scan_enabled_ms','reports_aggregated','visible_identifiers','unique_table_overflow','aggregation_drops','quality_flags','freshness'],
          properties: {
            node_id: ref('PlaceId'), boot_id: uuid, placement_id: ref('PlaceId'), protocol: { const: 'campuspulse/3' }, policy_id: ref('PlaceId'), assignment_generation: { type: 'integer', minimum: 1 },
            source: { type: 'string', const: 'sensor' }, dataset: { type: 'string', const: 'field' }, seq,
            observed_at: timestamp, valid_until: timestamp, uncertainty_ms: { type: 'integer', minimum: 0, maximum: 5000 },
            duration_ms: { type: 'integer', minimum: 1000, maximum: 300000 },
            scan_enabled_ms: count, reports_aggregated: count, visible_identifiers: count,
            unique_table_overflow: { type: 'boolean' }, aggregation_drops: count,
            quality_flags: { type: 'array', maxItems: 32, items: label },
            freshness: { type: 'string', enum: ['fresh','stale'] },
          },
          description: 'V3-only retained statistics window with known UTC, at most 5 seconds of clock uncertainty, only flags in the documented public allowlist and the whole uncertainty interval inside its registered placement. Identifiers are BLE observations, not people.',
        },
      },
    },
  };
  return addDeviceV3OpenApi(document);
}
