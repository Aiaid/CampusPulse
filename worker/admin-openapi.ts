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
  const anchor = entity({ x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 } });
  const observationKinds = { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true, items: { type: 'string', enum: ['activity', 'parking', 'elevator'] } };
  const placeFields = { name: string, kind: { type: 'string', enum: ['activity', 'parking', 'elevator'], description: 'Legacy primary purpose; must belong to observation_kinds when both are supplied.' }, observation_kinds: observationKinds, anchor, gis_anchor: { anyOf: [entity({ ...anchor.properties, verified: { type: 'boolean', const: true } }), { type: 'null' }] } };
  return {
    tags: [{ name: 'Administration', description: 'One managed administrator account with password/Passkeys, separate from operator/device/research credentials. Initial token login grants setup only and stops after initialization. Sensitive account/key/device-credential changes require fresh verification. All responses are no-store. Device credential registration/rotation returns a secret once; it is never included in list or audit responses.' }],
    securitySchemes: { AdminSession: { type: 'apiKey', in: 'cookie', name: 'cp_admin_session', description: 'Signed, expiring, server-revocable HttpOnly SameSite=Strict session obtained through POST /api/v1/admin/session. Secure on HTTPS. Cookies cannot be entered manually in Swagger; use /admin to log in.' } },
    schemas: {
      ...identity.schemas,
      MqttDeviceCredentials: entity({ uri: { type: 'string', const: 'mqtts://q9a692f8.ala.cn-hangzhou.emqxsl.cn:8883' }, username: { type: 'string', pattern: '^[a-z0-9_-]{1,15}$' }, password: { type: 'string', minLength: 16, maxLength: 96 }, namespace: { type: 'string', pattern: '^[a-z0-9_-]{1,15}$' } }),
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
        post: operation('registerAdminDevice', 'Register a device with a verified independent MQTT identity', 'post', entity({ id, name: string, board: string }), 'Requires fresh verification. Device, independent broker identity and audit commit atomically. Returns device, device HTTP credential and mqtt:{uri,username,password,namespace}. If no broker-verified pool row is ready, mqtt_pool_empty (503) creates no device. Secrets are never present in list or audit responses.', '201'),
      },
      '/api/v1/admin/mqtt/pool': {
        get: operation('listAdminMqttPool', 'List safe MQTT pool metadata and ready count', 'get', undefined, 'No passwords, encrypted credentials, upload tokens or one-time CSV exports are returned. Entries are bounded to 500 and report truncation.'),
        post: operation('createAdminMqttPool', 'Generate or explicitly import pending broker identities', 'post', { oneOf: [entity({ count: { type: 'integer', minimum: 1, maximum: 32 } }), entity({ entries: { type: 'array', minItems: 1, maxItems: 32, items: entity({ username: { type: 'string', pattern: '^[a-z0-9_-]{1,15}$' }, namespace: { type: 'string', pattern: '^[a-z0-9_-]{1,15}$' }, password: { type: 'string', minLength: 16, maxLength: 96 }, node_id: id }, ['username', 'namespace', 'password']) } })] }, 'Requires fresh verification. AES-GCM encrypted secrets are stored pending_broker. Returns safe entries and material:{authentication_csv,authorization_csv} once for the fixed production broker. CSV creation/import is not broker readiness. Optional imported node_id explicitly adopts an existing identity after a successful real probe; no implicit password rotation.', '201'),
      },
      '/api/v1/admin/mqtt/pool/{id}/verify': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        post: operation('verifyAdminMqttPoolIdentity', 'Verify production MQTT login and namespace ACLs', 'post', entity({}), 'Requires fresh verification. Real bounded MQTT5/TLS probe checks login, the firmware reply subscription, own request publication and denied cross-namespace/request subscriptions. The publish uses unsupported verify operation and creates no ingestion evidence. Failure revokes readiness; success marks ready or activates an explicit existing-node reservation.'),
      },
      '/api/v1/admin/devices/{id}/mqtt': {
        parameters: [pathId], post: operation('recoverAdminDeviceMqtt', 'Recover the same assigned MQTT credentials or allocate a verified identity', 'post', entity({}), 'Requires fresh verification and an enabled registered node. Returns mqtt:{uri,username,password,namespace}; the recovery audit contains no secrets. Existing assignments are decrypted without password rotation. Unassigned nodes atomically allocate a broker-verified ready row; pending reserved identities must pass verification first.'),
      },
      '/api/v1/admin/devices/{id}': {
        parameters: [pathId],
        get: operation('getAdminDevice', 'Read device details, policy and placement history', 'get'),
        patch: operation('updateAdminDevice', 'Edit device metadata or enable/disable future authentication', 'patch', entity({ name: string, board: string, enabled: { type: 'boolean' } }, [])),
      },
      '/api/v1/admin/devices/{id}/rotate-credential': {
        parameters: [pathId], post: operation('rotateAdminDeviceCredential', 'Invalidate the old device credential and return a new one once', 'post', entity({})),
      },
      '/api/v1/admin/devices/{id}/placements': {
        parameters: [pathId], post: operation('createAdminPlacement', 'Register a deployment and close an earlier open deployment', 'post', entity({ id, place_id: { type: ['string', 'null'] }, observation_kinds: observationKinds, valid_from_ms: { type: 'integer', minimum: 0 }, valid_until_ms: { type: ['integer', 'null'], minimum: 0 } }, ['id','place_id','valid_from_ms','valid_until_ms']), 'Selected observation_kinds must be a subset of the target place purposes. Omission selects all target purposes, or activity when unlocated. Every placement response and device placement history returns observation_kinds. Scope is immutable and separate from firmware V3 policy JSON; changing place or work purposes requires a new placement and a new published policy. Keeps old batch placement/config references intact. A registry change alone does not move a physical device or make firmware split capture windows.', '201'),
      },
      '/api/v1/admin/places': {
        get: operation('listAdminPlaces', 'List logical places and registered anchors', 'get'),
        post: operation('createAdminPlace', 'Create a logical place', 'post', { ...entity({ id, ...placeFields }, ['id', 'name', 'anchor']), anyOf: [{ required: ['kind'] }, { required: ['observation_kinds'] }] }, 'Provide nonempty unique observation_kinds, or legacy kind for one purpose. An omitted kind uses the first array entry as primary. If both are provided the primary must belong to the array. Responses always include observation_kinds.', '201'),
      },
      '/api/v1/admin/places/{id}': {
        parameters: [pathId], patch: operation('updateAdminPlace', 'Edit place metadata, observation purposes and anchors', 'patch', entity(placeFields, []), 'observation_kinds replaces enabled purposes; array-only updates select its first entry as primary. A legacy kind-only update selects that single purpose. Disabling a purpose preserves historical observations and placement scope, but rejects new manual entries of that purpose.'),
      },
      '/api/v1/admin/device-v3/prepare': { post: operation('prepareAdminV3Policy', 'Prepare a capability-bound native MQTT small-statistics policy', 'post', entity({node_id:id,placement_id:id,dataset:{type:'string',enum:['controlled_test','field','demo']}},['node_id','placement_id']), 'Read-only preparation from the actual registered capability snapshot. Default controlled_test, unclassified-v1, raw off. Returns valid, issues, policy, policy_sha256, expected_generation, applied:false and requires_device_ack:true. No assignment is created.') },
      '/api/v1/admin/device-v3/validate': { post: operation('validateAdminV3Policy', 'Validate V3 generation, capability, placement and policy', 'post', entity({policy:object,expected_generation:{type:'integer',minimum:0}}), 'Read-only capability negotiation. The assignment endpoint independently repeats all compatibility and transactional authorization checks. Compatible is never an applied ACK.') },
      '/api/v1/admin/settings': {
        get: operation('getAdminSettings', 'Read runtime settings and revision', 'get'),
        put: operation('updateAdminSettings', 'Save validated runtime settings using the current revision', 'put', entity({ settings: ref('AdminRuntimeSettings'), revision: integer }), 'Affects public defaults, contact freshness and new manual records. Does not rewrite historical observation expiry or retention.'),
      },
      '/api/v1/admin/audit': {
        get: { ...operation('listAdminAudit', 'Read bounded redacted management audit entries', 'get'), parameters: [{ name: 'before', in: 'query', required: false, schema: string }] },
      },
      ...identity.paths,
    },
  };
}
