/** Windows does not deliver SIGTERM to a Node webServer killed by Playwright. */
export default async function cleanup() {
  try {
    await fetch('http://127.0.0.1:8878/__test/shutdown', { method: 'POST', signal: AbortSignal.timeout(2000) });
    // Let the fixture dispose its sockets/database and remove its own temporary directory.
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((r) => setTimeout(r, 50));
      try { await fetch('http://127.0.0.1:8878/api/health', { signal: AbortSignal.timeout(100) }); }
      catch { return; }
    }
  } catch { /* The fixture may have already exited after a startup failure. */ }
}
