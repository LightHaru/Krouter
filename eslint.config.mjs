import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  { ignores: ['**/node_modules', '**/dist', '**/out'] },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules,
      // Codebase đã dùng sẵn quy ước tiền tố `_` để đánh dấu "cố ý không dùng"
      // (`_event`, `_head`, `_signal`, `{ id: _, ...rest }`...). Cấu hình rule cho khớp
      // quy ước đó, thay vì bắt sửa tên hoặc rải eslint-disable khắp nơi.
      // ignoreRestSiblings: bỏ qua biến bị destructure ra chỉ để LOẠI khỏi phần rest —
      // đó là cách chuẩn để bỏ một field, không phải biến thừa.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true
        }
      ]
    }
  },
  // Renderer: không bắt buộc chú thích kiểu trả về.
  //
  // Rule này có giá trị ở backend, nơi hàm tạo thành API giữa các module và kiểu trả về
  // đóng vai trò tài liệu (đã bật, đã annotate hết ở src/main + src/server). Trong renderer,
  // 248/267 vi phạm là handler cục bộ của component (`const handleSubmit = () => {...}`,
  // `const renderPage = () => {...}`) — TS suy luận chính xác, thêm `: void` vào từng chỗ
  // chỉ tạo nhiễu chứ không bắt được lỗi nào. Kiểu của props và của store vẫn được kiểm tra
  // đầy đủ qua `npm run typecheck:web`.
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off'
    }
  },
  // Kiểm tra dựa trên kiểu, chỉ áp cho tiến trình main của Electron.
  //
  // Lý do: đợt audit toàn dự án tìm ra một loạt lỗi cùng chung một hình dạng — một Promise
  // không ai await/catch/huỷ. `return this.passthrough(...)` trần bên trong try/catch khiến
  // rejection không bao giờ tới khối catch (chỗ duy nhất đóng response) nên request treo tới
  // khi client timeout; một listener bỏ rơi promise của handleRequest cũng vậy. Trong
  // src/main KHÔNG có handler unhandledRejection nào, nên những promise đó im lặng tuyệt đối.
  // Hai luật dưới đây bắt đúng lớp lỗi ấy bằng máy.
  //
  // Chỉ giới hạn ở src/main vì phân tích theo kiểu chậm hơn nhiều, và đây là nơi một
  // rejection lọt lưới có thể hạ cả tiến trình.
  {
    files: ['src/main/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json'],
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      // 'always' chứ không phải 'in-try-catch': chế độ in-try-catch còn bắt gỡ BỎ `await`
      // ở những chỗ nằm ngoài try, tức đi ngược lại chính các sửa lỗi phòng thủ ở đây, và
      // để lọt `return promise` trần khi try/catch nằm ở hàm gọi. 'always' chỉ thêm await —
      // vừa an toàn tuyệt đối, vừa giữ được stack trace của async.
      '@typescript-eslint/return-await': ['error', 'always']
    }
  },
  eslintConfigPrettier
)
