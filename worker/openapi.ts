import { addDeviceV2OpenApi } from './device-v2-openapi';
import { addElevatorEventsOpenApi } from './elevator-events-openapi';
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
  const bluetoothUuid = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' };
  const deviceUuid = { ...uuid, pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' };
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
  const batchBase = {
    protocol: { type: 'string', const: 'campuspulse/1' }, batch_id: deviceUuid,
    node_id: ref('PlaceId'), boot_id: deviceUuid, placement_id: ref('PlaceId'),
    capture_config_id: ref('PlaceId'), dataset: { type: 'string', enum: ['field', 'controlled_test', 'demo'] },
    firmware_version: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[^\\x00-\\x1f\\x7f]{1,80}$' },
  };
  const batchRequired = [...Object.keys(batchBase), 'stream', 'items'];
  const ingestErrors = {
    '400': error('Invalid JSON, duplicate key, UTF-8 or exact-body hash.', ['invalid_json', 'invalid_utf8', 'duplicate_json_key', 'body_hash_mismatch']),
    '401': error('Missing or incorrect device bearer credential.', ['unauthorized']),
    '403': error('Origin, node, or registered capture policy is not permitted.', ['origin_rejected', 'node_not_allowed', 'capture_config_not_allowed']),
    '410': error('Capture configuration expired; preserve the pending batch.', ['capture_config_expired']),
    '409': error('Batch ID content changed or sequence range overlaps.', ['batch_conflict', 'seq_range_overlap']),
    '413': error('Body exceeds the protocol or configured limit.', ['payload_too_large']),
    '415': error('Expected uncompressed application/json.', ['content_type', 'content_encoding']),
    '422': error('Strict envelope, item or config constraint failed.', ['invalid_ingest', 'capture_config_mismatch']),
    '503': error('Storage or registered policy unavailable.', ['storage_unavailable', 'capture_config_invalid', 'raw_storage_not_configured', 'raw_integrity_error', 'raw_object_missing'], true),
  };

  const document = {
    openapi: '3.1.0',
    info: {
      title: 'CampusPulse API', version: '0.3.0',
      description: 'Implemented public settings/place reads, shared-operator manual observations, shared-administrator management sessions, device ingestion/configuration activation reports and private research batch reads. Firmware and hardware field validation are pending; runtime provisioning and real-device onboarding must be verified separately in each environment. Synthetic examples illustrate the wire format; replace values and credentials before use. Try it out writes real data to this origin. Device uploads require X-Body-SHA256 of the exact UTF-8 JSON bytes sent; Swagger UI does not calculate it. API responses use Cache-Control: no-store.',
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
          description: 'Sensor is the latest retained field window from the past 24 hours with known UTC and uncertainty <=30 seconds. The entire interval [window start minus uncertainty, window end plus uncertainty] must fit the immutable placement. Only an empty flag list or the documented non-clock quality allowlist is public; unknown flags are withheld. Its valid_until is window UTC minus uncertainty plus 90 seconds. Top-level freshness is fresh when either that sensor window or the latest active manual observation is fresh, stale when at least one exists but neither is fresh, and no_data otherwise. No sensor means null, never zero people.',
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
      '/api/v1/ingest': {
        post: {
          operationId: 'ingestBatch', tags: ['Device ingestion'], summary: 'Durably ingest one stream batch',
          security: [{ DeviceToken: [] }],
          description: 'One immutable batch contains one stream only. Strict JSON rejects duplicate decoded keys, unknown fields, nonfinite/noninteger counts and item sequence disorder. Server checks bound node/config/placement/dataset/stream, policy expiry and configured lower limits. Raw batches require private R2 and receive an independent durable receipt. Identical batch ID and exact body bytes return the original ACK; changed bytes conflict. Scan responses remain separate reports. A malformed AD field does not reject otherwise valid raw evidence. X-Body-SHA256 is lowercase SHA-256 of the exact UTF-8 HTTP body bytes, not a hash of a reserialized object. Swagger UI cannot generate that header automatically; prepare and hash the exact body outside this UI before executing.',
          parameters: [{ name: 'X-Body-SHA256', in: 'header', required: true, description: '64 lowercase hex digits: SHA-256 of the exact UTF-8 request body bytes.', schema: hex64 }],
          requestBody: { required: true, 'x-max-body-bytes': 65536, content: { 'application/json': { schema: ref('IngestBatch') } } },
          responses: { '200': response('Committed ACK or original ACK for exact retry.', ref('IngestAck')), ...ingestErrors },
        },
      },
      '/api/v1/device/config': {
        get: {
          operationId: 'getDeviceConfig', tags: ['Device ingestion'], summary: 'Read the registered node capture policy',
          security: [{ DeviceToken: [] }],
          description: 'Returns the selected registered capture policy, server limits, expiry and retention. Without capture_config_id, selects the node policy with latest accept_until. This does not create, extend or authorize a policy by client assertion.',
          parameters: [{ name: 'capture_config_id', in: 'query', required: false, schema: ref('PlaceId'), description: 'Registered capture config ID; omit to select latest.' }],
          responses: {
            '200': response('Registered config and limits.', ref('DeviceConfigResponse')),
            '401': error('Missing or incorrect device bearer credential.', ['unauthorized']),
            '403': error('Origin or config access denied.', ['origin_rejected', 'capture_config_not_allowed']),
            '422': error('Invalid capture_config_id.', ['invalid_config_id']),
            '503': error('Storage or registered policy unavailable.', ['storage_unavailable', 'capture_config_invalid'], true),
          },
        },
      },
      '/api/v1/research/batches/{id}': {
        get: {
          operationId: 'getResearchBatch', tags: ['Private research'], summary: 'Read a retained raw batch and derived AD parsing',
          security: [{ ResearchToken: [] }],
          description: 'Requires an independent research credential and node_id query. Verifies the archived raw bytes against the stored SHA-256 before parsing. Returns original batch and derived records by seq; parser classification remains unknown until a separately versioned rule set exists. Raw evidence can contain identifying data. Response is private and no-store.',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: uuid, description: 'Raw batch UUIDv4.' },
            { name: 'node_id', in: 'query', required: true, schema: ref('PlaceId'), description: 'Node that owns this batch.' },
          ],
          responses: {
            '200': response('Verified raw evidence and derived parsing.', ref('ResearchBatchResponse')),
            '401': error('Research credential missing or incorrect.', ['unauthorized']),
            '403': error('Supplied Origin differs from request origin.', ['origin_rejected']),
            '404': error('Raw batch not found.', ['batch_not_found']),
            '410': error('Raw retention expired.', ['raw_expired']),
            '422': error('node_id query missing or invalid.', ['node_id_required']),
            '503': error('Research access or private archive unavailable.', ['research_not_configured', 'raw_storage_not_configured', 'raw_integrity_error', 'storage_unavailable'], true),
          },
        },
      },
      '/api/v1/observations': {
        post: {
          operationId: 'createObservation', tags: ['Operator writes'], summary: 'Commit a manual observation',
          description: 'Requires application/json (charset parameters are accepted), no Content-Encoding header, and a body no larger than 8192 bytes (8 KiB). Unknown fields, null numeric values, mixed parking/elevator fields and non-integer values are rejected. Parking minimum must not exceed maximum, and kind must match the registered place. valid_until is observed_at plus the configured observation TTL (15 minutes by default), not reception time; settings changes do not rewrite existing records; an accepted old observation may already be stale. New insertion returns 201; an identical ID/content retry returns 200, including the current cancelled status if already cancelled. Changed content for an existing ID returns 409. Relative timestamp validation is repeated on retries, so retries older than 24 hours are rejected. Confirmation follows the D1 write. Replace the synthetic examples with actual measurements: Try it out creates real records.',
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
          type: 'object', additionalProperties: false, required: ['id', 'name', 'kind', 'anchor', 'coverage'],
          properties: {
            id: ref('PlaceId'), name: { type: 'string' }, kind: { type: 'string', enum: ['activity', 'parking', 'elevator'] },
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
          type: 'object', additionalProperties: false, required: ['place', 'sensor', 'latest_observation', 'freshness', 'as_of'],
          properties: {
            place: ref('Place'), sensor: { oneOf: [ref('PublicSensorWindow'), { type: 'null' }] },
            latest_observation: { oneOf: [ref('Observation'), { type: 'null' }] },
            freshness: { type: 'string', enum: ['no_data', 'fresh', 'stale'] }, as_of: timestamp,
          },
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
          required: ['node_id','boot_id','placement_id','capture_config_id','source','dataset','seq','observed_at','valid_until','uncertainty_ms','duration_ms','scan_enabled_ms','reports_aggregated','visible_identifiers','unique_table_overflow','aggregation_drops','quality_flags','freshness'],
          properties: {
            node_id: ref('PlaceId'), boot_id: uuid, placement_id: ref('PlaceId'), capture_config_id: ref('PlaceId'),
            source: { type: 'string', const: 'sensor' }, dataset: { type: 'string', const: 'field' }, seq,
            observed_at: timestamp, valid_until: timestamp, uncertainty_ms: { type: 'integer', minimum: 0, maximum: 30000 },
            duration_ms: { type: 'integer', minimum: 1000, maximum: 300000 },
            scan_enabled_ms: count, reports_aggregated: count, visible_identifiers: count,
            unique_table_overflow: { type: 'boolean' }, aggregation_drops: count,
            quality_flags: { type: 'array', maxItems: 32, items: label },
            freshness: { type: 'string', enum: ['fresh','stale'] },
          },
          description: 'Field-only retained window with known UTC, at most 30 seconds of clock uncertainty, only flags in the documented public allowlist and the whole uncertainty interval inside its registered placement. Identifiers are BLE observations, not people.',
        },
        IngestTime: {
          type: 'object', additionalProperties: false, required: ['mono_ms','utc_ms','clock_epoch','uncertainty_ms'],
          properties: { mono_ms: count, utc_ms: { type: ['integer','null'], minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
            clock_epoch: count, uncertainty_ms: nullableCount },
          description: 'utc_ms=null means uncalibrated; uncertainty_ms must then be null too. mono_ms is boot-relative.',
        },
        RssiSummary: {
          type: 'object', additionalProperties: false, required: ['samples','min_dbm','max_dbm','mean_dbm'],
          properties: { samples: count, min_dbm: { type: ['integer','null'], minimum: -127, maximum: 126 },
            max_dbm: { type: ['integer','null'], minimum: -127, maximum: 126 },
            mean_dbm: { type: ['number','null'], minimum: -127, maximum: 126 } },
          description: 'All min/max/mean are null iff samples=0; otherwise min<=mean<=max.',
        },
        RawCapture: {
          type: 'object', additionalProperties: false,
          required: ['mode','selected_reports','intentional_skips','pressure_skips','drops'],
          properties: { mode: { type: 'string', enum: ['off','all','sampled'] }, selected_reports: count,
            intentional_skips: count, pressure_skips: count, drops: count },
          description: 'For on modes selected+intentional+pressure=reports_seen and drops<=selected. In off mode all counts are zero; all mode has no intentional skips.',
        },
        ReportRateIndex: {
          type: 'object', additionalProperties: false, required: ['metric','value','unit','algorithm_id','calibration_id'],
          properties: { metric: { type: 'string', const: 'report_rate' }, value: { type: 'number', minimum: 0 },
            unit: { type: 'string', const: 'reports_per_scan_enabled_second' },
            algorithm_id: { type: 'string', const: 'report-rate-v1' }, calibration_id: { type: 'null' } },
          description: 'Only when scan_enabled_ms>0; must equal reports_aggregated*1000/scan_enabled_ms within 1e-6 absolute or relative tolerance.',
        },
        BleWindow: {
          type: 'object', additionalProperties: false,
          required: ['seq','time','duration_ms','scan_enabled_ms','reports_seen','reports_aggregated','aggregation_drops','adv_reports','scan_response_reports','visible_identifiers','unique_table_capacity','unique_table_overflow','rssi','raw_capture','quality_flags'],
          properties: { seq, time: ref('IngestTime'), duration_ms: { type: 'integer', minimum: 1000, maximum: 300000 },
            scan_enabled_ms: count, reports_seen: count, reports_aggregated: count, aggregation_drops: count,
            adv_reports: count, scan_response_reports: count, visible_identifiers: count, unique_table_capacity: count,
            unique_table_overflow: { type: 'boolean' }, rssi: ref('RssiSummary'), raw_capture: ref('RawCapture'),
            indices: { type: 'array', maxItems: 1, items: ref('ReportRateIndex') },
            quality_flags: { type: 'array', maxItems: 32, uniqueItems: true, items: label } },
          description: 'mono_ms>=duration_ms; scan_enabled<=duration; seen=aggregated+drops; aggregated=adv+scan responses; visible<=aggregated and table capacity; RSSI samples<=aggregated. Raw mode must match registered config.',
        },
        ReportIdentity: { oneOf: [ref('MacIdentity'), ref('WindowTokenIdentity'), ref('NoIdentity')], discriminator: { propertyName: 'scheme' } },
        MacIdentity: { type: 'object', additionalProperties: false, required: ['scheme','address','address_type'], properties: {
          scheme: { type: 'string', const: 'mac' }, address: { type: 'string', pattern: '^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$' },
          address_type: { type: 'string', enum: ['public','random','public_identity','random_identity','unknown'] },
        } },
        WindowTokenIdentity: { type: 'object', additionalProperties: false, required: ['scheme','token','address_type'], properties: {
          scheme: { type: 'string', const: 'window_token' }, token: { type: 'string', pattern: '^[0-9a-f]{32}$' },
          address_type: { type: 'string', enum: ['public','random','public_identity','random_identity','unknown'] },
        } },
        NoIdentity: { type: 'object', additionalProperties: false, required: ['scheme'], properties: { scheme: { type: 'string', const: 'none' } } },
        BleReport: {
          type: 'object', additionalProperties: false, required: ['seq','time','window_seq','identity','rssi_dbm','report_type','report_type_code','format','payload_length','payload_hex'],
          properties: { seq, time: ref('IngestTime'), window_seq: seq, identity: ref('ReportIdentity'),
            rssi_dbm: { type: ['integer','null'], minimum: -127, maximum: 126 },
            report_type: { type: 'string', enum: ['adv_ind','adv_direct_ind','adv_scan_ind','adv_nonconn_ind','scan_rsp','unknown'] },
            report_type_code: { type: 'integer', minimum: 0, maximum: 255 }, format: { type: 'string', const: 'legacy_ad' },
            payload_length: { type: 'integer', minimum: 0, maximum: 31 },
            payload_hex: { type: 'string', pattern: '^(?:[0-9a-f]{2}){0,31}$', maxLength: 62 } },
          description: 'payload_length equals payload_hex byte count. The original AD bytes are preserved even when AD parsing is malformed. Identity scheme must match config.',
        },
        StreamCounts: { type: 'object', additionalProperties: false, required: ['ble_windows','ble_reports','node_status'],
          properties: { ble_windows: count, ble_reports: count, node_status: count } },
        LossTotals: { type: 'object', additionalProperties: false,
          required: ['aggregation_drops','raw_queue_drops','storage_drops','windows_dropped','upload_failures','ack_failures','status_samples_coalesced','raw_pressure_skips'],
          properties: Object.fromEntries(['aggregation_drops','raw_queue_drops','storage_drops','windows_dropped','upload_failures','ack_failures','status_samples_coalesced','raw_pressure_skips'].map(key => [key, count])) },
        BufferHealth: { type: 'object', additionalProperties: false,
          required: ['log_budget_bytes','used_bytes','unacked_bytes','reclaimable_bytes','incoming_local_Bps','newly_acknowledged_local_Bps','time_to_full_s','growth_state','pressure_level','pause_reason','raw_paused_ms','pre_pause_incoming_local_Bps'],
          properties: { log_budget_bytes: { type: 'integer', minimum: 1 }, used_bytes: count, unacked_bytes: count,
            reclaimable_bytes: count, incoming_local_Bps: { type: ['number','null'], minimum: 0 },
            newly_acknowledged_local_Bps: { type: ['number','null'], minimum: 0 }, time_to_full_s: { type: ['number','null'], minimum: 0 },
            growth_state: label, pressure_level: label, pause_reason: { oneOf: [label, { type: 'null' }] },
            raw_paused_ms: count, pre_pause_incoming_local_Bps: { type: ['number','null'], minimum: 0 } },
          description: 'used<=budget; unacked and reclaimable<=used; unacked+reclaimable<=used; raw_paused_ms<=uptime; time_to_full_s=null for unknown or stable_or_draining growth.',
        },
        NodeStatus: { type: 'object', additionalProperties: false,
          required: ['seq','time','uptime_ms','scan_state','wifi_state','free_heap_bytes','queue_pending','queue_capacity','storage_free_bytes','raw_capture_state','loss_totals','buffer_health'],
          properties: { seq, time: ref('IngestTime'), uptime_ms: count, scan_state: label, wifi_state: label,
            free_heap_bytes: count, queue_pending: ref('StreamCounts'), queue_capacity: ref('StreamCounts'),
            storage_free_bytes: count, raw_capture_state: label, battery_mv: { type: 'integer', minimum: 0, maximum: 10000 },
            wifi_rssi_dbm: { type: 'integer', minimum: -127, maximum: 0 },
            loss_totals: ref('LossTotals'), buffer_health: ref('BufferHealth') },
          description: 'One status item per batch. mono_ms<=uptime; queue_pending<=capacity per stream.',
        },
        BleWindowsBatch: { type: 'object', additionalProperties: false, required: batchRequired,
          properties: { ...batchBase, stream: { type: 'string', const: 'ble_windows' }, items: { type: 'array', minItems: 1, maxItems: 128, items: ref('BleWindow') } } },
        BleReportsBatch: { type: 'object', additionalProperties: false, required: batchRequired,
          properties: { ...batchBase, stream: { type: 'string', const: 'ble_reports' }, items: { type: 'array', minItems: 1, maxItems: 128, items: ref('BleReport') } } },
        NodeStatusBatch: { type: 'object', additionalProperties: false, required: batchRequired,
          properties: { ...batchBase, stream: { type: 'string', const: 'node_status' }, items: { type: 'array', minItems: 1, maxItems: 1, items: ref('NodeStatus') } } },
        IngestBatch: { oneOf: [ref('BleWindowsBatch'), ref('BleReportsBatch'), ref('NodeStatusBatch')], discriminator: { propertyName: 'stream' },
          description: 'Single stream, strictly increasing seq. Server additionally checks registered config binding, upload policy and expiry.' },
        IngestAck: { type: 'object', additionalProperties: false,
          required: ['node_id','boot_id','stream','batch_id','body_sha256','accepted_count','durability','receipt_id','received_at'],
          properties: { node_id: ref('PlaceId'), boot_id: uuid, stream: { type: 'string', enum: ['ble_windows','ble_reports','node_status'] },
            batch_id: uuid, body_sha256: hex64, accepted_count: { type: 'integer', minimum: 1, maximum: 128 },
            durability: { type: 'string', const: 'committed' }, receipt_id: uuid, received_at: timestamp } },
        CaptureConfig: { type: 'object', additionalProperties: false,
          required: ['capture_config_id','node_id','placement_id','dataset','capture_profile','allowed_streams','scan','raw_capture','identity_scheme','accept_until','upload_policy'],
          properties: {
            capture_config_id: ref('PlaceId'), node_id: ref('PlaceId'), placement_id: ref('PlaceId'),
            dataset: { type: 'string', enum: ['field','controlled_test','demo'] },
            capture_profile: { type: 'string', enum: ['metrics','research_raw'] },
            allowed_streams: { type: 'array', uniqueItems: true, items: { type: 'string', enum: ['ble_windows','ble_reports','node_status'] } },
            scan: { type: 'object', additionalProperties: false, required: ['stack','adapter_version','mode','interval_ms','window_ms','filter_duplicates','host_filter'],
              properties: { stack: { type: 'string' }, adapter_version: { type: 'string' }, mode: { type: 'string', enum: ['passive','active'] },
                interval_ms: { type: 'number', exclusiveMinimum: 0 }, window_ms: { type: 'number', exclusiveMinimum: 0 },
                filter_duplicates: { type: 'boolean' }, host_filter: { type: 'string' } } },
            raw_capture: { type: 'object', additionalProperties: false, required: ['mode'], properties: {
              mode: { type: 'string', enum: ['off','all','sampled'] }, sample_every_n: { type: 'integer', minimum: 1 }, selection: { type: 'string' } } },
            identity_scheme: { type: 'string', enum: ['mac','window_token','none'] }, accept_until: timestamp,
            upload_policy: { type: 'object', additionalProperties: false,
              required: ['max_items','max_body_bytes','flush_max_age_ms','warn_pct','raw_pause_pct','critical_pct','resume_pct','overload_action'],
              properties: { max_items: { type: 'integer', minimum: 1, maximum: 128 }, max_body_bytes: { type: 'integer', minimum: 1, maximum: 65536 },
                flush_max_age_ms: count, warn_pct: { type: 'number', minimum: 0, maximum: 100 },
                raw_pause_pct: { type: 'number', minimum: 0, maximum: 100 }, critical_pct: { type: 'number', minimum: 0, maximum: 100 },
                resume_pct: { type: 'number', minimum: 0, maximum: 100 }, overload_action: { type: 'string', enum: ['pause_raw','pause_scan'] } } },
          } },
        DeviceConfigResponse: { type: 'object', additionalProperties: false,
          required: ['protocol','config','server_limits','expired','server_time','retention'],
          properties: { protocol: { type: 'string', const: 'campuspulse/1' }, config: ref('CaptureConfig'),
            server_limits: { type: 'object', additionalProperties: false, required: ['max_items','max_body_bytes'], properties: {
              max_items: { type: 'integer', const: 128 }, max_body_bytes: { type: 'integer', const: 65536 } } },
            expired: { type: 'boolean' }, server_time: timestamp,
            retention: { type: 'object', additionalProperties: false, required: ['raw_hours','aggregate_days','receipt_min_days_after_accept_until'], properties: {
              raw_hours: count, aggregate_days: count, receipt_min_days_after_accept_until: { type: 'integer', const: 7 } } } } },
        AdElement: { type: 'object', additionalProperties: false, required: ['offset','ad_length','type','value_hex'], properties: {
          offset: count, ad_length: { type: 'integer', minimum: 1, maximum: 255 }, type: { type: 'integer', minimum: 0, maximum: 255 },
          value_hex: { type: 'string', pattern: '^(?:[0-9a-f]{2})*$' } } },
        DerivedReport: { type: 'object', additionalProperties: false,
          required: ['seq','parser_version','parse_status','elements','names','service_uuids','manufacturer_data','service_data','flags','tx_power','appearance','ruleset_version','classification'],
          properties: { seq, parser_version: { type: 'string', const: 'ble-ad-v1' }, parse_status: { type: 'string', enum: ['ok','malformed'] },
            elements: { type: 'array', items: ref('AdElement') },
            names: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['ad_offset','complete','bytes_hex','display_text'], properties: {
              ad_offset: count, complete: { type: 'boolean' }, bytes_hex: { type: 'string', pattern: '^(?:[0-9a-f]{2})*$' }, display_text: { type: 'string' } } } },
            service_uuids: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['ad_offset','ad_type','source_width_bits','uuid'], properties: {
              ad_offset: count, ad_type: count, source_width_bits: { type: 'integer', enum: [16,32,128] }, uuid: bluetoothUuid } } },
            manufacturer_data: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['ad_offset','ad_length','company_id','company_name','vendor_data_hex','vendor_data_length'], properties: {
              ad_offset: count, ad_length: count, company_id: { type: 'integer', minimum: 0, maximum: 65535 }, company_name: { type: 'null' },
              vendor_data_hex: { type: 'string', pattern: '^(?:[0-9a-f]{2})*$' }, vendor_data_length: count } } },
            service_data: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['ad_offset','ad_type','source_width_bits','uuid','data_hex'], properties: {
              ad_offset: count, ad_type: count, source_width_bits: { type: 'integer', enum: [16,32,128] }, uuid: bluetoothUuid,
              data_hex: { type: 'string', pattern: '^(?:[0-9a-f]{2})*$' } } } },
            flags: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['ad_offset','value'], properties: { ad_offset: count, value: { type: 'integer', minimum: 0, maximum: 255 } } } },
            tx_power: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['ad_offset','dbm'], properties: { ad_offset: count, dbm: { type: 'integer', minimum: -128, maximum: 127 } } } },
            appearance: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['ad_offset','value'], properties: { ad_offset: count, value: { type: 'integer', minimum: 0, maximum: 65535 } } } },
            ruleset_version: { type: 'string', const: 'unclassified-v1' },
            classification: { type: 'object', additionalProperties: false, required: ['category','confidence','rule_id','ruleset_version','evidence'], properties: {
              category: { type: 'string', const: 'unknown' }, confidence: { type: 'string', const: 'none' }, rule_id: { type: 'null' },
              ruleset_version: { type: 'string', const: 'unclassified-v1' }, evidence: { type: 'array', maxItems: 0 } } },
          } },
        ResearchBatchResponse: { type: 'object', additionalProperties: false, required: ['batch','body_sha256','derived'], properties: {
          batch: ref('BleReportsBatch'), body_sha256: hex64, derived: { type: 'array', items: ref('DerivedReport') } } },
      },
    },
  };
  return addElevatorEventsOpenApi(addDeviceV2OpenApi(document));
}
