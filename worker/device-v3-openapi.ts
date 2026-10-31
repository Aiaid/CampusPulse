/** V3 device control and small-statistics contracts. Business API versions are independent. */
export function addDeviceV3OpenApi<T extends { paths: object; components: { schemas: object } }>(document: T): T {
  const schema = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const result = (name: string, description = 'Request completed.') => ({ description, content: { 'application/json': { schema: schema(name) } } });
  const failures = Object.fromEntries([400, 401, 403, 409, 410, 413, 415, 422, 429, 503].map(status => [String(status), {
    description: status === 409 ? 'Frozen identity, sequence or authority conflict; preserve the original request.'
      : status === 410 ? 'Original acceptance or source-retention deadline expired.' : 'Request rejected; inspect the machine error code and retryable flag.',
    content: { 'application/json': { schema: schema('DeviceV3Error') } },
  }]));
  const device = (operationId: string, request: string | null, response: string, description: string, hash = false) => ({
    operationId, tags: ['Device ingestion'], security: [{ DeviceToken: [] }], description,
    ...(request ? { requestBody: { required: true, content: { 'application/json': { schema: schema(request) } } } } : {}),
    ...(hash ? { parameters: [{ name: 'X-Body-SHA256', in: 'header', required: true, schema: { type: 'string', pattern: '^[0-9a-f]{64}$' } }] } : {}),
    responses: { '200': result(response), ...failures },
  });
  const identity = { protocol: { const: 'campuspulse/3' }, node_id: { type: 'string' }, boot_id: { type: 'string', format: 'uuid' },
    policy_id: { type: 'string' }, policy_sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' }, assignment_generation: { type: 'integer', minimum: 1 } };
  const admin = (operationId: string, method: 'get' | 'post', description: string) => ({
    operationId, tags: ['Administration'], security: [{ AdminSession: [] }], description,
    ...(method === 'get' ? { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^[a-z0-9_-]{1,64}$' } }] }
      : { requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false,
          required: ['policy','expected_generation'], properties: { policy: { type: 'object' }, expected_generation: { type: 'integer', minimum: 0 } } } } } } }),
    responses: { '200': result('DeviceV3Response'), ...failures },
  });
  Object.assign(document.paths, {
    '/api/v1/admin/device-v3/assignments': { post: admin('assignDeviceV3Policy', 'post', 'Commit a capability-bound frozen V3 policy under generation compare-and-swap. Requires a later device applied ACK.') },
    '/api/v1/admin/device-v3/nodes/{id}': { get: admin('inspectDeviceV3Control', 'get', 'Read current boot, claimed capability, frozen desired assignment and applied acknowledgement separately.') },
    '/api/v1/admin/device-v3/nodes/{id}/evidence': { get: admin('inspectDeviceV3Evidence', 'get', 'Read bounded V3 statistics, receipts and loss diagnostics. Historical projection counts are audit metadata only.') },
    '/api/v3/device/capabilities': { post: device('registerDeviceV3Capabilities', 'DeviceV3Registration', 'DeviceV3Response', 'Register this boot capability declaration. Capabilities remain device claims, not hardware acceptance.') },
    '/api/v3/device/config': { get: { ...device('readDeviceV3Config', null, 'DeviceV3Response', 'Read the frozen policy for the registered boot and capability digest.'), parameters: [{ name: 'boot_id', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } }] } },
    '/api/v3/device/config/ack': { post: device('acknowledgeDeviceV3Config', 'DeviceV3Acknowledgement', 'DeviceV3Response', 'Commit an applied or rejected policy acknowledgement. Only the committed applied acknowledgement authorizes subsequent collection.') },
    '/api/v3/device/lease': { post: device('renewDeviceV3Lease', 'DeviceV3ControlRequest', 'DeviceV3Response', 'Renew bounded collection authority. Receipt-only replay cannot create new authority.') },
    '/api/v3/ingest': { post: device('ingestDeviceV3Features', 'DeviceV3FeatureBatch', 'DeviceV3Receipt', 'Optional gated private V3 feature evidence. Send X-Body-SHA256 of the exact UTF-8 HTTP body bytes; preserve frozen policy, boot, sequence and batch identity across retries.', true) },
    '/api/v3/statistics/ingest': { post: device('ingestDeviceV3Statistics', 'DeviceV3StatisticsBatch', 'DeviceV3Receipt', 'Ingest bounded compact V3 statistics using the exact UTF-8 HTTP body bytes. Formal production transport is native MQTT/TLS through the authenticated gateway; this endpoint shares the same frozen authority and receipt validation.', true) },
    '/api/v3/places/{id}/statistics': { get: { operationId: 'readPlaceV3Statistics', tags: ['Public reads'],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^[a-z0-9_-]{1,64}$' } }],
      description: 'One stable active receiver, field-only statistics. No population estimate, private identities, or replacement for manual elevator waits.',
      responses: { '200': result('PublicStatisticsV3'), '503': failures['503'] } } },
  });
  Object.assign(document.components.schemas, {
    DeviceV3Error: { type: 'object', required: ['error'], properties: { error: { type: 'object', required: ['code','retryable'], properties: { code: { type: 'string' }, message: { type: 'string' }, retryable: { type: 'boolean' } } } } },
    DeviceV3Registration: { type: 'object', additionalProperties: false, required: ['protocol','registration_seq','uptime_ms','capabilities'], properties: {
      protocol: { const: 'campuspulse/3' }, registration_seq: { type: 'integer', minimum: 1 }, uptime_ms: { type: 'integer', minimum: 0 }, capabilities: { type: 'object', description: 'Exact device-capabilities/3 declaration; full nested capability negotiation is validated by the server.' } } },
    DeviceV3ControlRequest: { type: 'object', description: 'Strict boot-bound V3 config/lease request; use the matching device-control/3 specification. Unknown fields are rejected by the runtime.' },
    DeviceV3Acknowledgement: { type: 'object', additionalProperties: false, required: ['protocol','boot_id','policy_id','policy_sha256','assignment_generation','apply_seq','state','closed_window_seq','closed_segment_seq','window_open','segment_open'], properties: {
      protocol: identity.protocol, boot_id: identity.boot_id, policy_id: identity.policy_id, policy_sha256: identity.policy_sha256, assignment_generation: identity.assignment_generation,
      apply_seq: { type: 'integer', minimum: 1 }, state: { enum: ['applied','failed'] }, closed_window_seq: { type: 'integer', minimum: 0 }, closed_segment_seq: { type: 'integer', minimum: 0 },
      window_open: { type: 'boolean' }, segment_open: { type: 'boolean' }, error_code: { enum: ['unsupported_config','boundary_failed','resource_exhausted','storage_failed','internal_error'] } }, description: 'Failed ACKs require error_code; applied ACKs prohibit it. Frozen receipt recovery uses X-Receipt-Only: 1.' },
    DeviceV3Response: { type: 'object', description: 'V3 control response, including original frozen identity and receipt metadata as applicable.' },
    DeviceV3FeatureBatch: { type: 'object', required: ['protocol','node_id','boot_id','policy_id','policy_sha256','assignment_generation','batch_id','stream','items'], properties: {
      ...identity, batch_id: { type: 'string', format: 'uuid' }, stream: { enum: ['feature_summaries','node_status'] }, items: { type: 'array', minItems: 1 } } },
    DeviceV3StatisticsBatch: { type: 'object', additionalProperties: false, required: ['p','z','b','n','o','c','h','g','d','k','x'], properties: {
      p: { const: 3 }, z: { const: 'statistics/1' }, b: { type: 'string', format: 'uuid' }, n: { type: 'string' }, o: { type: 'string', format: 'uuid' }, c: { type: 'string' }, h: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      g: { type: 'integer', minimum: 1 }, d: { enum: ['field','controlled_test','demo'] }, k: { enum: ['window_statistics','candidate_events','node_status'] },
      x: { type: 'array', minItems: 1, items: { type: 'object' }, description: 'Compact tuple records validated against the immutable capability-negotiated policy; full-window arithmetic, loss, time, resource and category invariants remain mandatory.' } } },
    DeviceV3Receipt: { type: 'object', required: ['protocol','node_id','boot_id','batch_id','body_sha256','durability','receipt_id','received_at','expires_at','retain_until'], properties: {
      ...identity, batch_id: { type: 'string', format: 'uuid' }, body_sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' }, durability: { const: 'committed' }, receipt_id: { type: 'string', format: 'uuid' }, received_at: { type: 'string', format: 'date-time' }, expires_at: { type: 'string', format: 'date-time' }, retain_until: { type: 'string', format: 'date-time' } } },
    PublicStatisticsV3: { type: 'object', required: ['schema','state','estimated_total'], properties: { schema: { const: 'public-statistics/3' }, state: { enum: ['unavailable','observed','partial_observation'] }, estimated_total: { type: 'null' }, visible_identifiers: { type: ['integer','null'] }, activity: { type: ['object','null'] } } },
  });
  return document;
}
