import { createMockPanel, mockOptions } from '../server/mock-xtream.mjs';
const options = mockOptions({ ...process.env, MOCK_PROFILE: 'stress' });
const { server } = createMockPanel(options);
const port = Number(process.env.PORT || 8790);
const host = process.env.MOCK_HOST || '127.0.0.1';
server.listen(port, host, () => console.log(`Stress Xtream fixture on http://${host}:${port}: ${options.channels} channels, ${options.movies} movies, ${options.series} series (demo/demo).`));
