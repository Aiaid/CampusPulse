SELECT
  json_encode(
    map_put('published_at_ms', timestamp,
      map_put('payload_b64', base64_encode(payload),
        map_put('topic', topic,
          map_put('username', username,
            map_put('qos', qos,
              map_put('retain', map_get('retain', flags, false), json_decode('{}')))))))
  ) AS webhook_body
FROM "cp/v1/+/+/req/+/+"
WHERE qos = 1 AND map_get('retain', flags, false) = false
  AND (topic(6) = 'contact' OR topic(6) = 'config'
       OR topic(6) = 'activation' OR topic(6) = 'ingest')
