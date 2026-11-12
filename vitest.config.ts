import { defineConfig } from 'vitest/config';

// Клиентские тесты отдельно от релея: у релея свои тесты (cd relay && npm test).
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify('test') },
  test: { include: ['tests/js/**/*.test.{ts,tsx}'] }
});
