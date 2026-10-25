import { createAdminIdentityOpenApi } from './admin-identity-openapi';

/** Admin operations use the same origin's revocable HttpOnly session cookie. */
export function createAdminOpenApi() {
  const identity = createAdminIdentityOpenApi();
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const string = { type: 'string' };
  const object = { type: 'object' };
  const integer = { type: 'integer', minimum: 1 };
  const id = { type: 'string', pattern: '^[a-z0-9_-]{1,64}$' };
  const json = (description: string, schema: object = object) => ({ description, content: { 'application/json': { schema } } });
  const errors = {
    '400': json('Malformed JSON or session input.'),
    '401': json('Administrator session is absent, expired, revoked or invalid.'),
    '403': json('A same-origin Origin header is required for browser mutations.'),
    '404': json('Unknown registered resource.'),
    '409': json('Revision changed, ID exists, or mutation conflicts with retained history. Reload before retrying.'),
    '422': json('Strict validation failed; no partial mutation is committed.'),
    '503': json('Administrator authentication is not configured or storage is unavailable.'),
  };
  const body = (schema: object) => ({ required: true, content: { 'application/json': { schema } } });
  const entity = (properties: Record<string, object>, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
  const pathId = { name: 'id', in: 'path', required: true, schema: id };
  function operation(operationId: string, summary: string, method: string, schema?: object, description?: string, status = '200') {
    return {
      operationId, summary, description: description ?? 'Requires an administrator session. Mutations and their redacted audit entry commit together.',
      tags: ['Administration'], security: [{ AdminSession: [] }],
      ...(schema ? { requestBody: body(schema) } : {}),
      responses: { [status]: json(method === 'get' ? 'Current server state; no credential digests or raw identifiers.' : 'Committed server result.', object), ...errors },
    };
  }
  const draftBody = entity({ config: ref('AnyCaptureConfig'), raw_retention_hours: { type: 'integer', minimum: 1, maximum: 8760 }, aggregate_retention_days: { type: 'integer', minimum: 1, maximum: 3650 } }, ['config']);
  const draftUpdate = entity({ ...draftBody.properties, revision: integer }, ['config', 'revision']);
  const revision = entity({ revision: integer });
  const anchor = entity({ x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 } });
  const placeFields = { name: string, kind: { type: 'string', enum: ['activity', 'parking', 'elevator'] }, anchor, gis_anchor: { anyOf: [entity({ ...anchor.properties, verified: { type: 'boolean', const: true } }), { type: 'null' }] } };
  return {
    tags: [{ name: 'Administration', description: 'One managed administrator account with password/Passkeys, separate from operator/device/research credentials. Initial token login grants setup only and stops after initialization. Sensitive account/key/device-credential changes require fresh verification. All responses are no-store. Device credential registration/rotation returns a secret once; it is never included in list or audit responses.' }],
    securitySchemes: { AdminSession: { type: 'apiKey', in: 'cookie', name: 'cp_admin_session', description: 'Signed, expiring, server-revocable HttpOnly SameSite=Strict session obtained through POST /api/v1/admin/session. Secure on HTTPS. Cookies cannot be entered manually in Swagger; use /admin to log in.' } },
    schemas: {
      ...identity.schemas,
      PublicSiteSettings: entity({ site_name: string, default_mode: { type: 'string', enum: ['demo', 'field'] } }),
      AdminRuntimeSettings: entity({
        site_name: { type: 'string', minLength: 1, maxLength: 80 }, default_mode: { type: 'string', enum: ['demo', 'field'] },
        stale_after_seconds: { type: 'integer', minimum: 30, maximum: 604800 },
        observation_ttl_minutes: { type: 'integer', minimum: 1, maximum: 1440 },
        default_raw_retention_hours: { type: 'integer', minimum: 1, maximum: 8760 },
        default_aggregate_retention_days: { type: 'integer', minimum: 1, maximum: 3650 },
      }),
    },
    paths: {
      '/api/v1/settings': { get: { operationId: 'getPublicSiteSettings', tags: ['Public reads'], summary: 'Read public site name and initial map mode', security: [], responses: { '200': json('Public defaults only.', ref('PublicSiteSettings')), '503': errors['503'] } } },
      '/api/v1/admin/overview': { get: operation('getAdminOverview', 'Read fleet contact and configuration overview', 'get', undefined, 'Contact freshness uses server receipt time and the configured threshold. Recent contact is not proof of current scan activity or radio completeness.') },
      '/api/v1/admin/devices': {
        get: { ...operation('listAdminDevices', 'List devices, latest health and configuration state', 'get'), parameters: [{ name: 'after', in: 'query', required: false, schema: id, description: 'Use the previous next_cursor; each response contains at most 200 devices.' }] },
        post: operation('registerAdminDevice', 'Register a device and return its random credential once', 'post', entity({ id, name: string, board: string }), undefined, '201'),
      },
      '/api/v1/admin/devices/{id}': {
        parameters: [pathId],
        get: operation('getAdminDevice', 'Read device details, policy and placement history', 'get'),
        patch: operation('updateAdminDevice', 'Edit device metadata or enable/disable future authentication', 'patch', entity({ name: string, board: string, enabled: { type: 'boolean' } }, [])),
      },
      '/api/v1/admin/devices/{id}/batches': {
        parameters: [pathId], get: { ...operation('listAdminDeviceBatches', 'List committed upload receipts for one device', 'get', undefined, 'Authenticated private diagnostics. Lists receipt metadata only; no R2 object reads, raw identifiers or credentials. Keyset pagination is bounded to 50 receipts. Local pending data is not available to this API.'),
          parameters: [{ name: 'stream', in: 'query', schema: { type: 'string', enum: ['ble_windows','address_summaries','node_status','ble_reports'] } }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 } }, { name: 'before', in: 'query', schema: { type: 'string', maxLength: 256 }, description: 'Opaque next_cursor from the preceding page.' }] },
      },
      '/api/v1/admin/devices/{id}/batches/{batchId}': {
        parameters: [pathId, { name: 'batchId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        get: { ...operation('getAdminDeviceBatch', 'Inspect one retained upload payload and its provenance', 'get', undefined, 'Administrator-only private read. May contain BLE identifiers or advertisement bytes. Returns retention-limited normalized D1 projection, separately labeled from one original R2 body. Exact UTF-8 text is returned only after a bounded 65536-byte read and matching receipt SHA-256. Missing, expired, corrupted or credential-bearing archives return explicit unavailability; no reconstructed wire bytes. Never includes network or device credentials.'), responses: { '200': json('Committed receipt with normalized projection and independently verified original body when available.'), ...errors } },
      },
      '/api/v1/admin/devices/{id}/rotate-credential': {
        parameters: [pathId], post: operation('rotateAdminDeviceCredential', 'Invalidate the old device credential and return a new one once', 'post', entity({})),
      },
      '/api/v1/admin/devices/{id}/placements': {
        parameters: [pathId], post: operation('createAdminPlacement', 'Register a deployment and close an earlier open deployment', 'post', entity({ id, place_id: { type: ['string', 'null'] }, valid_from_ms: { type: 'integer', minimum: 0 }, valid_until_ms: { type: ['integer', 'null'], minimum: 0 } }), 'Keeps old batch placement/config references intact. A registry change alone does not move a physical device or make firmware split capture windows.', '201'),
      },
      '/api/v1/admin/places': {
        get: operation('listAdminPlaces', 'List logical places and registered anchors', 'get'),
        post: operation('createAdminPlace', 'Create a logical place', 'post', entity({ id, ...placeFields }, ['id', 'name', 'kind', 'anchor']), undefined, '201'),
      },
      '/api/v1/admin/places/{id}': {
        parameters: [pathId], patch: operation('updateAdminPlace', 'Edit place metadata and anchors', 'patch', entity(placeFields, [])),
      },
      '/api/v1/admin/configs': {
        get: { ...operation('listAdminConfigs', 'Read editable drafts and published historical policies', 'get'), parameters: [{ name: 'node_id', in: 'query', required: false, schema: id }] },
        post: operation('createAdminConfigDraft', 'Create an editable capture-policy draft', 'post', draftBody, 'Omitted retention values use current site defaults. Drafts do not authorize ingestion until published.', '201'),
      },
      '/api/v1/admin/configs/{id}': {
        parameters: [pathId], put: operation('updateAdminConfigDraft', 'Edit a draft using its current revision', 'put', draftUpdate),
      },
      '/api/v1/admin/configs/{id}/validate': {
        parameters: [pathId], post: operation('validateAdminConfigDraft', 'Validate a saved draft and registered associations', 'post', revision),
      },
      '/api/v1/admin/configs/{id}/publish': {
        parameters: [pathId], post: operation('publishAdminConfigDraft', 'Publish a policy version and set the desired device policy', 'post', revision, 'Publication does not confirm device activation. Clone to a fresh ID for the next version; already queued batches retain their exact historical policy. The UI distinguishes pending, batch-reported, explicitly applied and failed.'),
      },
      '/api/v1/admin/settings': {
        get: operation('getAdminSettings', 'Read runtime settings and revision', 'get'),
        put: operation('updateAdminSettings', 'Save validated runtime settings using the current revision', 'put', entity({ settings: ref('AdminRuntimeSettings'), revision: integer }), 'Affects public defaults, contact freshness and new manual records/new draft defaults. Does not rewrite historical observation expiry or retention.'),
      },
      '/api/v1/admin/audit': {
        get: { ...operation('listAdminAudit', 'Read bounded redacted management audit entries', 'get'), parameters: [{ name: 'before', in: 'query', required: false, schema: string }] },
      },
      '/api/v1/device/config/ack': {
        post: {
          operationId: 'acknowledgeDeviceConfig', tags: ['Device ingestion'], summary: 'Report whether this node applied its assigned capture policy',
          description: 'Authenticated device report only, not independent hardware validation. A queued batch referencing a policy is not an activation acknowledgement. Only registered assigned versions can be acknowledged.',
          security: [{ DeviceToken: [] }], requestBody: body(entity({ capture_config_id: id, state: { type: 'string', enum: ['applied', 'failed'] }, message: { type: 'string', maxLength: 80, pattern: '^[a-z0-9][a-z0-9_.:-]{0,79}$' } }, ['capture_config_id', 'state'])),
          responses: { '200': json('Server saved the device activation report.'), ...errors,
            '401': json('Device credential is missing, invalid or disabled.'),
            '403': json('Configuration was not assigned to this node, or a supplied Origin differs from the request origin.'),
          },
        },
      },
      ...identity.paths,
    },
  };
}
