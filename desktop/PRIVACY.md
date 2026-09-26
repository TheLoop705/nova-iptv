# Nova for Windows: privacy

Last updated: September 27, 2026

Nova is an open-source player published by TheLoop705. It does not provide an account, TV subscription or cloud library service.

## Data on your PC

Nova stores your playlists, provider credentials, favorites, watch progress and settings in your Windows user profile under `%APPDATA%\Nova`. The main database is `nova.db`; browser storage and caches are also in that directory. Provider credentials are not encrypted separately in this database. Protect access to your Windows account and backups.

The bundled local service runs on this PC and is not exposed to your local network. Nova does not send your saved library to the developer, and the Windows app includes no advertising, analytics or crash-reporting service.

## Network connections

When you add or use a provider, Nova connects to the playlist, guide, artwork, authentication and streaming URLs supplied by that provider. These services receive your IP address and requests; provider credentials are sent when required to access that provider. Their own privacy policies apply. HTTPS encrypts these connections; providers using HTTP do not offer that protection.

Choosing the built-in demo connects to third-party public test stream and artwork hosts. **Help → Get updates** opens GitHub in your browser, where GitHub's privacy policy applies. Fonts are bundled locally in the Windows app.

## Removing data and contacting us

You can remove playlists in Nova. Uninstalling preserves the data directory so an update or reinstall can restore your library. To remove all Nova data, close Nova and delete `%APPDATA%\Nova` and any backups you made of it.

For questions, use the [project's GitHub issues](https://github.com/TheLoop705/nova-iptv/issues). Issues are public; do not post provider passwords, private playlist URLs or other personal information.
