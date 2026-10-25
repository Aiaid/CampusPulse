import { lazy, Suspense, useEffect, useState } from 'react';

const AdminApp = lazy(() => import('./admin/AdminApp.jsx'));
const CampusApp = lazy(() => import('./campus/App.jsx').then(module => ({ default: module.App })));
type SiteSettings = { site_name: string; default_mode: 'demo' | 'field' };

function CampusEntry() {
  const [settings, setSettings] = useState<SiteSettings | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    fetch('/api/v1/settings', { signal: controller.signal, credentials: 'same-origin' })
      .then(async response => {
        if (!response.ok) throw new Error('Settings unavailable');
        const value = await response.json() as SiteSettings;
        if (typeof value.site_name !== 'string' || !['demo', 'field'].includes(value.default_mode)) throw new Error('Invalid settings');
        setSettings(value);
      })
      .catch(() => {
        if (controller.signal.reason === 'unmount') return;
        setUnavailable(true);
        setSettings({ site_name: 'CampusPulse', default_mode: 'field' });
      })
      .finally(() => clearTimeout(timeout));
    return () => { clearTimeout(timeout); controller.abort('unmount'); };
  }, []);
  useEffect(() => { if (settings) document.title = settings.site_name; }, [settings]);
  if (!settings) return <div role="status" style={{ padding: 24 }}>正在读取站点设置…</div>;
  return <>
    {unavailable && <div role="status" style={{ position: 'fixed', bottom: 170, right: 16, zIndex: 1000, display: 'flex', alignItems: 'center', gap: 12, maxWidth: 'min(300px, calc(100vw - 32px))', padding: '10px 12px', borderRadius: 8, background: '#fff4d7', color: '#574323', boxShadow: '0 2px 12px #0002', fontSize: 12 }}>
      <span>站点设置暂不可用，已使用现场视图默认值。</span><button type="button" aria-label="关闭站点设置提示" onClick={() => setUnavailable(false)} style={{ flexShrink: 0, border: 0, background: 'transparent', color: 'inherit', padding: 6, cursor: 'pointer' }}>关闭</button>
    </div>}
    <CampusApp defaultMode={settings.default_mode} siteName={settings.site_name} />
  </>;
}

export default function App() {
  const admin = window.location.pathname === '/admin' || window.location.pathname.startsWith('/admin/');
  return <Suspense fallback={<div role="status" style={{ padding: 24 }}>{admin ? '正在打开管理后台…' : '正在打开校园地图…'}</div>}>
    {admin ? <AdminApp /> : <CampusEntry />}
  </Suspense>;
}
