// Nội dung hướng dẫn cho trang Docs (thuần dữ liệu, không phụ thuộc React/ảnh).
// Tách riêng để test được mà không kéo theo chuỗi import ảnh/asset.
//
// Quy ước: bất kỳ bước nào có `image` (tham chiếu key trong docsImages) thì
// PHẢI có `alt` mô tả không rỗng. StepImage cũng tự fallback alt khi render.

export const DOCS_LOCAL_URL = 'http://127.0.0.1:4010'
export const DOCS_PROXY_ENDPOINT = 'http://127.0.0.1:5580/v1'

export interface DocStep {
  text: string
  image?: string
  alt?: string
}

export interface DocSectionContent {
  id: string
  title: string
  intro?: string
  steps: DocStep[]
}

export const DOC_SECTIONS: DocSectionContent[] = [
  {
    id: 'setup',
    title: 'Thiết lập và đăng nhập lần đầu',
    intro: `Mở dashboard Krouter ở địa chỉ local ${DOCS_LOCAL_URL} (hoặc link tunnel nếu chạy trên VPS). Lần đầu bạn cần tạo mật khẩu admin.`,
    steps: [
      {
        text: `Mở trình duyệt và truy cập ${DOCS_LOCAL_URL}. Nếu là lần đầu, Krouter sẽ hỏi tạo mật khẩu admin: chọn "Krouter tạo" (mật khẩu ngẫu nhiên an toàn) hoặc "Tự đặt".`,
        image: 'setup-login',
        alt: 'Màn hình đăng nhập / thiết lập mật khẩu admin của Krouter'
      },
      {
        text: 'Nếu chọn mật khẩu ngẫu nhiên, Krouter chỉ hiển thị một lần — hãy lưu lại ngay. Sau đó bấm "Vào dashboard".',
        image: 'setup-password',
        alt: 'Krouter hiển thị mật khẩu admin được tạo tự động, chỉ hiện một lần'
      },
      {
        text: 'Những lần sau, chỉ cần nhập mật khẩu admin để đăng nhập vào dashboard.'
      }
    ]
  },
  {
    id: 'accounts',
    title: 'Thêm và nhập tài khoản Kiro',
    intro: 'Sau khi đăng nhập, vào trang Tài khoản để thêm hoặc nhập (import) các tài khoản Kiro bạn muốn dùng cho API proxy.',
    steps: [
      {
        text: 'Mở mục "Tài khoản" ở thanh bên. Bạn sẽ thấy danh sách tài khoản hiện có cùng quota, gói dịch vụ và trạng thái sống/chết của từng tài khoản.',
        image: 'accounts-list',
        alt: 'Trang Tài khoản hiển thị danh sách tài khoản Kiro với quota và trạng thái'
      },
      {
        text: 'Bấm "Thêm tài khoản" để đăng nhập một tài khoản Kiro mới, hoặc dùng nút Import để nhập tài khoản từ file/token đã có.',
        image: 'accounts-add',
        alt: 'Hộp thoại thêm/nhập tài khoản Kiro'
      },
      {
        text: 'Sau khi thêm, Krouter tự làm mới token và đọc quota. Tài khoản có quota còn lại và còn sống sẽ được API proxy sử dụng để xoay tua.'
      }
    ]
  },
  {
    id: 'proxy',
    title: 'Bật API Proxy và tạo API key',
    intro: `Trang Proxy API là nơi bật/tắt dịch vụ proxy, xem log request và quản lý API key cho client. Endpoint mặc định là ${DOCS_PROXY_ENDPOINT}.`,
    steps: [
      {
        text: 'Mở mục "Proxy API" ở thanh bên. Bật dịch vụ proxy (Start). Khi bật, backend sẽ chạy proxy độc lập, không phụ thuộc tab trình duyệt.',
        image: 'proxy-panel',
        alt: 'Trang Proxy API với nút bật/tắt dịch vụ và thông tin endpoint'
      },
      {
        text: 'Vào phần quản lý API Key, bấm "Tạo key" để sinh một key dạng sk-... dùng cho client. Bạn có thể đặt giới hạn credits cho từng key.',
        image: 'proxy-apikey',
        alt: 'Màn hình tạo và quản lý API key cho client'
      },
      {
        text: `Cấu hình client với Base URL ${DOCS_PROXY_ENDPOINT}, API Key vừa tạo, và chọn model do Krouter cung cấp (ví dụ claude-sonnet-4.5).`
      }
    ]
  },
  {
    id: 'openclaw',
    title: 'Import vào OpenClaw / client',
    intro: 'Krouter cung cấp provider "krouter" để dùng trong OpenClaw và các công cụ tương thích OpenAI.',
    steps: [
      {
        text: 'Tạo một API key trong trang Proxy API (xem mục trên).',
        image: 'openclaw-config',
        alt: 'Hộp thoại cấu hình client / import OpenClaw trong dashboard'
      },
      {
        text: 'Trên máy có OpenClaw, chạy lệnh: krouter openclaw import. OpenClaw sẽ dùng provider "krouter".'
      },
      {
        text: `Trong client, đặt Base URL ${DOCS_PROXY_ENDPOINT} và API Key sk-... Khi gọi /models, Krouter trả về danh sách model đang khả dụng qua proxy.`
      }
    ]
  },
  {
    id: 'tunnel',
    title: 'Truy cập public qua tunnel',
    intro: 'Khi cần truy cập dashboard từ xa (ví dụ trên VPS), bạn có thể publish nó qua tunnel và lấy một link public.',
    steps: [
      {
        text: 'Trong terminal (SSH vào VPS), gõ "krouter" để mở dashboard CLI, hoặc "krouter tunnel start" để bật tunnel public.',
        image: 'tunnel-cli',
        alt: 'CLI Krouter hiển thị trạng thái và link tunnel'
      },
      {
        text: 'Krouter sẽ in ra link public. Mở link đó trên trình duyệt; trang vẫn yêu cầu đăng nhập như bản local.'
      },
      {
        text: 'Trang hướng dẫn này cũng truy cập được tại <link>/docs trên cả bản local lẫn bản tunnel.'
      }
    ]
  }
]
