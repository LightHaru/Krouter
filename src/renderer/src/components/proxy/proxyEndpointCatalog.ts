export type ProxyEndpointMethod = 'GET' | 'POST'

export interface ProxyEndpointDefinition {
  method: ProxyEndpointMethod
  path: string
  label: { en: string; vi: string }
  optional?: boolean
}

export interface ProxyEndpointGroup {
  id: 'inference' | 'media' | 'agents' | 'operations' | 'auth' | 'admin'
  title: { en: string; vi: string }
  endpoints: ProxyEndpointDefinition[]
}

export const PROXY_ENDPOINT_GROUPS: ProxyEndpointGroup[] = [
  {
    id: 'inference',
    title: { en: 'Inference', vi: 'Suy luận' },
    endpoints: [
      { method: 'POST', path: '/v1/chat/completions', label: { en: 'OpenAI Chat', vi: 'Chat chuẩn OpenAI' } },
      { method: 'POST', path: '/v1/responses', label: { en: 'OpenAI Responses', vi: 'OpenAI Responses' } },
      { method: 'POST', path: '/v1/messages', label: { en: 'Claude Messages', vi: 'Claude Messages' } },
      { method: 'POST', path: '/anthropic/v1/messages', label: { en: 'Claude Code', vi: 'Claude Code' } },
      { method: 'POST', path: '/v1/messages/count_tokens', label: { en: 'Token count', vi: 'Đếm token' } },
      { method: 'POST', path: '/v1beta/models/:model:generateContent', label: { en: 'Gemini generate', vi: 'Tạo nội dung Gemini' } },
      { method: 'POST', path: '/v1beta/models/:model:streamGenerateContent', label: { en: 'Gemini stream', vi: 'Stream Gemini' } }
    ]
  },
  {
    id: 'media',
    title: { en: 'Images', vi: 'Hình ảnh' },
    endpoints: [
      { method: 'POST', path: '/v1/images/generations', label: { en: 'Generate image', vi: 'Tạo hình ảnh' } },
      { method: 'GET', path: '/v1/images/:filename', label: { en: 'Serve generated image', vi: 'Mở hình đã tạo' } }
    ]
  },
  {
    id: 'agents',
    title: { en: 'Agents and skills', vi: 'Agent và kỹ năng' },
    endpoints: [
      { method: 'POST', path: '/mcp', label: { en: 'MCP JSON-RPC', vi: 'MCP JSON-RPC' } },
      { method: 'GET', path: '/api/skills/list', label: { en: 'Skill catalog', vi: 'Danh sách kỹ năng' } },
      { method: 'GET', path: '/api/skills/content?id=:id', label: { en: 'Skill content', vi: 'Nội dung kỹ năng' } },
      { method: 'GET', path: '/skills/:id/SKILL.md', label: { en: 'Skill document', vi: 'Tài liệu kỹ năng' } }
    ]
  },
  {
    id: 'operations',
    title: { en: 'Discovery and operations', vi: 'Khám phá và vận hành' },
    endpoints: [
      { method: 'GET', path: '/v1/models', label: { en: 'Model catalog', vi: 'Danh sách model' } },
      { method: 'GET', path: '/v1beta/models', label: { en: 'Gemini models', vi: 'Model Gemini' } },
      { method: 'GET', path: '/health', label: { en: 'Health check', vi: 'Kiểm tra sức khỏe' } },
      { method: 'GET', path: '/metrics', label: { en: 'Prometheus metrics', vi: 'Metrics Prometheus' }, optional: true }
    ]
  },
  {
    id: 'auth',
    title: { en: 'ChatGPT image account', vi: 'Tài khoản hình ảnh ChatGPT' },
    endpoints: [
      { method: 'POST', path: '/auth/chatgpt/login', label: { en: 'Start OAuth', vi: 'Bắt đầu OAuth' } },
      { method: 'POST', path: '/auth/chatgpt/cancel', label: { en: 'Cancel OAuth', vi: 'Hủy OAuth' } },
      { method: 'GET', path: '/auth/chatgpt/status', label: { en: 'OAuth status', vi: 'Trạng thái OAuth' } },
      { method: 'POST', path: '/auth/chatgpt/logout', label: { en: 'Disconnect account', vi: 'Ngắt kết nối' } },
      { method: 'POST', path: '/auth/chatgpt/token', label: { en: 'Store tokens', vi: 'Lưu token thủ công' } }
    ]
  },
  {
    id: 'admin',
    title: { en: 'Admin API (API key required)', vi: 'Admin API (cần API key)' },
    endpoints: [
      { method: 'GET', path: '/admin/stats', label: { en: 'Detailed stats', vi: 'Thống kê chi tiết' } },
      { method: 'POST', path: '/admin/bedrock/test', label: { en: 'Test Bedrock', vi: 'Kiểm tra Bedrock' } },
      { method: 'GET', path: '/admin/accounts', label: { en: 'Account list', vi: 'Danh sách tài khoản' } },
      { method: 'GET', path: '/admin/config', label: { en: 'Read config', vi: 'Đọc cấu hình' } },
      { method: 'POST', path: '/admin/config', label: { en: 'Update config', vi: 'Cập nhật cấu hình' } },
      { method: 'GET', path: '/admin/audit', label: { en: 'Audit log', vi: 'Nhật ký kiểm toán' } },
      { method: 'GET', path: '/admin/logs', label: { en: 'Request logs', vi: 'Nhật ký request' } },
      { method: 'POST', path: '/admin/cache/clear', label: { en: 'Clear caches', vi: 'Xóa cache' } },
      { method: 'GET', path: '/admin/endpoint-metrics', label: { en: 'Endpoint metrics', vi: 'Metrics endpoint' } },
      { method: 'POST', path: '/admin/endpoint-metrics/reset', label: { en: 'Reset endpoint metrics', vi: 'Đặt lại metrics endpoint' } },
      { method: 'GET', path: '/admin/account-health', label: { en: 'Account health', vi: 'Sức khỏe tài khoản' } },
      { method: 'GET', path: '/admin/quota-predictions', label: { en: 'Quota predictions', vi: 'Dự báo quota' } }
    ]
  }
]
