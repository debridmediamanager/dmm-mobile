import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['src/**/*.test.ts', 'ota/**/*.test.ts'],
		coverage: {
			provider: 'v8',
			include: ['src/**/*.{ts,tsx}'],
			exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
			reporter: ['text', 'json-summary'],
		},
		setupFiles: ['./test.setup.ts'],
		globals: true,
		clearMocks: true,
	},
});
