import { app, dialog, Menu, nativeTheme, shell } from 'electron';
import { join } from 'node:path';
import { registerDesktopScheme, startDesktop } from './runtime.mjs';

app.setName('Nova');
app.setAppUserModelId('com.theloop705.nova');
app.setPath('userData', join(app.getPath('appData'), 'Nova'));
registerDesktopScheme();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let desktop;
  app.on('second-instance', () => {
    const window = desktop?.window;
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => { void desktop?.close(); });

  app.whenReady().then(async () => {
    nativeTheme.themeSource = 'dark';
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Nova', submenu: [{ role: 'quit' }] },
      { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'View', submenu: [{ role: 'togglefullscreen', accelerator: 'F11' }] },
      { label: 'Help', submenu: [{ label: 'Get updates', click: () => void shell.openExternal('https://github.com/TheLoop705/nova-iptv/releases') }] },
    ]));
    desktop = await startDesktop();
  }).catch((error) => {
    dialog.showErrorBox('Nova could not start', error.message);
    app.exit(1);
  });
}
