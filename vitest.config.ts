import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000, // beforeAll của integration test tạo DB + áp migration
    // Integration test dùng DB riêng theo pid, nhưng chạy tuần tự để tránh tranh chấp kết nối.
    fileParallelism: false,
  },
});
