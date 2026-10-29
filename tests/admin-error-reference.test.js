import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { adminErrorReference } from '../src/admin/error-reference.js';
import { ErrorNotice } from '../src/admin/shared.jsx';

const requestId = '12345678-1234-4567-89ab-123456789abc';
it('renders a valid failure reference alongside the original error', () => {
  expect(adminErrorReference(requestId)).toBe(requestId);
  const html = renderToStaticMarkup(React.createElement(ErrorNotice, { error: { message: 'Temporarily unavailable', code: 'storage_unavailable', requestId } }));
  expect(html).toContain('storage_unavailable');
  expect(html).toContain(`错误参考：${requestId}`);
});
it.each([undefined, null, 123, {}, '<script>private</script>', `${requestId}\nprivate`, '12345678-1234-1567-89ab-123456789abc'])('rejects a non-reference value before rendering', value => {
  expect(adminErrorReference(value)).toBeNull();
  const html = renderToStaticMarkup(React.createElement(ErrorNotice, { error: { message: 'Temporarily unavailable', requestId: value } }));
  expect(html).not.toContain('错误参考');
  expect(html).not.toContain('private');
});
