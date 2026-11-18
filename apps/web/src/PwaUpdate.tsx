import { useEffect, useState } from 'react';

export function PwaUpdate() {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;

    const workers = navigator.serviceWorker;
    const events = new AbortController();
    const options = { signal: events.signal };
    let controller = workers.controller;
    workers.addEventListener(
      'controllerchange',
      () => {
        const next = workers.controller;
        // The first install claims this page too. Only a replacement is an update.
        if (controller && next && next !== controller) setAvailable(true);
        controller = next;
      },
      options,
    );

    const registration = workers.register('/sw.js', { updateViaCache: 'none' }).catch(() => null);
    async function checkForUpdate() {
      const registered = await registration;
      if (events.signal.aborted || !registered || document.hidden || !navigator.onLine) return;
      await registered.update().catch(() => undefined);
    }
    document.addEventListener('visibilitychange', () => void checkForUpdate(), options);
    window.addEventListener('online', () => void checkForUpdate(), options);
    return () => events.abort();
  }, []);

  if (!available) return null;
  return (
    <aside className="pwa-update" aria-label="应用更新">
      <p role="status">新版已就绪，当前页的输入会保留。</p>
      <a href={window.location.href} target="_blank" rel="noopener">
        打开新版
      </a>
    </aside>
  );
}
