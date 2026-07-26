import tseslint from 'typescript-eslint'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default tseslint.config(
  { ignores: ['**/node_modules', '**/dist', '**/dist-web', '**/out', '**/out-server', '**/build'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      react: eslintPluginReact,
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    settings: {
      react: { version: 'detect' }
    },
    rules: {
      ...eslintPluginReact.configs.flat.recommended.rules,
      ...eslintPluginReact.configs.flat['jsx-runtime'].rules,
      ...eslintPluginReactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // react/prop-types kiểm tra khai báo PropTypes lúc chạy — thứ codebase này không dùng.
      // Kiểu của props đã được TypeScript kiểm tra đầy đủ qua `npm run typecheck:web`, nên
      // bật rule này chỉ tạo lỗi giả ở mọi component viết bằng React.forwardRef.
      'react/prop-types': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  },
  // Kiểm tra dựa trên kiểu cho backend (server + phần src/main còn lại sau khi bỏ Electron).
  //
  // Chỉ bật DUY NHẤT no-floating-promises, và bật vì nó có thành tích cụ thể: trong đợt audit
  // toàn dự án nó tìm ra 3 lỗi thật mà đọc tay đã bỏ sót — nhánh 'unsupported-handler' trong
  // mitmHttpsServer, handler HTTP của mcpServer, và stdio transport của mcpServer. Cả ba đều
  // là promise bị bỏ rơi: rejection không tới được khối catch (chỗ duy nhất đóng response),
  // nên request treo tới khi client timeout mà không có một dòng log nào.
  //
  // Backend không có handler unhandledRejection, nên đây không phải rule về style — nó là
  // máy dò đúng lớp lỗi im lặng nhất trong codebase này.
  //
  // Phạm vi file phải khớp "include" của tsconfig.server.json, vì phân tích theo kiểu chỉ
  // chạy được trên file thuộc project đó.
  {
    files: [
      'src/server/**/*.ts',
      'src/main/proxy/**/*.ts',
      'src/main/kproxy/**/*.ts',
      'src/main/registration/**/*.ts',
      'src/main/utils/**/*.ts',
      'src/main/runtimePaths.ts',
      'src/main/kiroAuthSync.ts'
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.server.json'],
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error'
    }
  }
)
