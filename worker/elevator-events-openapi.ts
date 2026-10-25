interface Document {
  paths: Record<string, unknown>;
  components: { schemas: Record<string, unknown> };
  [key: string]: unknown;
}

export function addElevatorEventsOpenApi(document: Document): Document {
  const timestamp = { type: 'string', format: 'date-time' };
  const count = { type: 'integer', minimum: 0, maximum: 64 };
  const object = (properties: Record<string, unknown>) => ({
    type: 'object', additionalProperties: false, required: Object.keys(properties), properties,
  });
  const event = object({
    id: { type: 'string', pattern: '^[0-9a-f]{32}$' },
    event_from: timestamp, event_to: timestamp, confirmed_at: timestamp,
    baseline_identifiers: count, lost_identifiers: count,
    lost_fraction: { type: 'number', minimum: 0, maximum: 1 },
    verification: { type: 'string', const: 'unverified' },
    reappearance_flag: { type: 'boolean' }, reappeared_identifiers: count,
  });
  document.components.schemas.ElevatorEvents = object({
    place_id: { $ref: '#/components/schemas/PlaceId' }, as_of: timestamp,
    data_until: { oneOf: [timestamp, { type: 'null' }] },
    valid_until: { oneOf: [timestamp, { type: 'null' }] },
    status: { type: 'string', enum: ['warming_up', 'observing', 'degraded', 'unavailable', 'stale'] },
    reason: { type: ['string', 'null'] }, rule_version: { type: 'string', const: 'cohort-disappearance-v0' },
    events: { type: 'array', maxItems: 20, items: event }, truncated: { type: 'boolean' },
  });
  const response = (description: string, schema: unknown) => ({ description,
    headers: { 'Cache-Control': { schema: { type: 'string', const: 'no-store' } } },
    content: { 'application/json': { schema } },
  });
  document.paths['/api/v1/places/{id}/elevator-events'] = { get: {
    operationId: 'getElevatorEvents', tags: ['Public observations'], security: [],
    summary: 'Read field-only synchronized BLE disappearance candidates',
    description: 'Read-only bounded projection of the latest node/boot/placement/config partition, using private retained v2 summaries and node health. No identifiers are returned. Candidates are unverified, not people counts, actual elevator departures or wait predictions. Missing evidence stays unavailable/degraded; delayed data expires by observation time. No database migration or model training is required.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/PlaceId' } }],
    responses: {
      200: response('Bounded field events and independent data-quality state.', { $ref: '#/components/schemas/ElevatorEvents' }),
      404: response('Unknown place.', { type: 'object' }),
      422: response('Place is not an elevator observation point.', { type: 'object' }),
      503: response('Storage is temporarily unavailable.', { type: 'object' }),
    },
  } };
  return document;
}
