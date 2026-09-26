import { app, BrowserWindow, protocol, session } from 'electron';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ORIGIN = 'nova://app';
const root = fileURLToPath(new URL('../', import.meta.url));

export function registerDesktopScheme() {
  // A stable origin keeps IndexedDB caches and device preferences across launches.
  protocol.registerSchemesAsPrivileged([{
    scheme: 'nova',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  }]);
}

export function isAppUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'nova:' && url.host === 'app' && !url.username && !url.password;
  } catch {
    return false;
  }
}

export async function startDesktop({ show = true, dist = app.isPackaged ? join(root, 'dist') : join(root, '.desktop', 'app', 'dist') } = {}) {
  if (!existsSync(join(dist, 'index.html'))) throw new Error('The Windows app has not been built. Run npm run build:windows first.');

  // Only this process knows the server credential. Other apps/websites cannot read
  // the playlist database or use the local proxy, even if they discover its port.
  const credential = `nova:${randomBytes(32).toString('hex')}`;
  process.env.DIST = dist;
  process.env.NOVA_DB = join(app.getPath('userData'), 'nova.db');
  process.env.BASIC_AUTH = credential;
  process.env.ALLOW_PRIVATE = '1'; // A desktop user can add a provider on their LAN.
  process.env.ALLOWED_HOSTS = '';
  const { server } = await import('../server/index.mjs');
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const backendOrigin = `http://127.0.0.1:${server.address().port}`;
  const authorization = `Basic ${Buffer.from(credential).toString('base64')}`;

  protocol.handle('nova', async (request) => {
    if (!isAppUrl(request.url)) return new Response('Not found', { status: 404 });
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.set('authorization', authorization);
    headers.set('accept-encoding', 'identity');
    headers.delete('host');
    try {
      const response = await fetch(`${backendOrigin}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
        redirect: 'error',
      });
      const outgoing = new Headers(response.headers);
      outgoing.set('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: http: https:",
        "media-src 'self' blob: http: https:",
        "connect-src 'self' blob: http: https:",
        "font-src 'self' data:",
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-src 'none'",
      ].join('; '));
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers: outgoing });
    } catch {
      return new Response('The local Nova service is unavailable.', { status: 502 });
    }
  });

  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(permission === 'fullscreen' && isAppUrl(contents.getURL()));
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission, origin) => {
    return permission === 'fullscreen' && isAppUrl(origin);
  });

  const window = new BrowserWindow({
    title: 'Nova',
    width: 1280,
    height: 760,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: '#07090D',
    icon: join(root, 'assets', 'icon.png'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!isAppUrl(url)) event.preventDefault(); });
  window.webContents.on('will-redirect', (event, url) => { if (!isAppUrl(url)) event.preventDefault(); });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());

  let closing = false;
  window.on('close', (event) => {
    if (closing) return;
    event.preventDefault();
    closing = true;
    let timeout;
    // Settings are debounced in the web app. Finish saving before stopping its server.
    Promise.race([
      window.webContents.executeJavaScript('window.novaFlushSettings?.()'),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Save timed out')), 5000); }),
    ]).catch((error) => console.error('Could not flush settings on exit:', error.message)).finally(() => {
      clearTimeout(timeout);
      if (!window.isDestroyed()) window.destroy();
    });
  });

  const close = async () => {
    if (!window.isDestroyed()) window.destroy();
    protocol.unhandle('nova');
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  try {
    await window.loadURL(`${APP_ORIGIN}/`);
    if (show) window.show();
  } catch (error) {
    await close();
    throw error;
  }
  return { window, backendOrigin, close };
}
