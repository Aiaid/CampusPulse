import { captureHelp } from './help-capture.js';
import { deviceHelp } from './help-device.js';
import { siteHelp } from './help-site.js';

// Static explanations only: never interpolate settings, observations or secrets.
export const adminHelp = Object.freeze({ ...captureHelp, ...deviceHelp, ...siteHelp });
export function resolveAdminHelp(topic) {
  if (topic && typeof topic === 'object' && typeof topic.title === 'string') return topic;
  return typeof topic === 'string' && Object.hasOwn(adminHelp, topic) ? adminHelp[topic] : null;
}
