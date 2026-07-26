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
    id: 'mitm',
    title: 'Kết nối Kiro, Copilot, Antigravity hoặc Cursor qua MITM',
    intro: 'MITM dùng CA cục bộ và DNS Redirect để đưa HTTPS của từng IDE vào Krouter. Mỗi IDE là một profile độc lập; bật Kiro không tự bật các IDE khác.',
    steps: [
      { text: 'Mở MITM. Ở thanh Core, bấm Install CA và chấp nhận UAC. Chỉ cài lại khi chứng chỉ bị xóa hoặc hết hiệu lực.' },
      { text: 'Bấm Start :443. Trạng thái phải là Listening :443; nếu cổng đang bận, đóng dịch vụ HTTPS khác đang giữ cổng rồi thử lại.' },
      { text: 'Chọn đúng card IDE, ví dụ Kiro IDE. Kiểm tra danh sách domain rồi bật DNS Redirect của profile đó và chấp nhận UAC. Krouter chỉ sửa block được đánh dấu trong file hosts.' },
      { text: 'Nếu IDE gửi tên model khác Krouter, thêm alias ở Routing Aliases rồi bấm Save aliases. Không cần alias nếu muốn giữ nguyên tên model.' },
      { text: 'Mở lại IDE, gửi một prompt ngắn và kiểm tra Profile Telemetry tăng. Khi dừng Krouter lâu dài, hãy tắt DNS Redirect trước để IDE trở về endpoint gốc.' }
    ]
  },
  {
    id: 'pool',
    title: 'Thiết lập và đọc đúng trạng thái Proxy Pool',
    intro: 'Proxy Pool tách proxy kết nối được khỏi proxy đủ nhanh để route. Reachable là số sống thực tế; Fast / Usable là số nằm dưới ngưỡng latency.',
    steps: [
      { text: 'Mở Proxy Pool, thêm một proxy hoặc import danh sách. Chọn Validate để đo kết nối và latency trước khi sử dụng.' },
      { text: 'Đọc Reachable để biết tổng proxy kết nối được. Proxy sống nhưng vượt Maximum usable latency vẫn được giữ lại với trạng thái Slow và không được tự chọn để route.' },
      { text: 'Đặt Maximum usable latency phù hợp đường truyền, thường bắt đầu ở 2500 ms. Ngưỡng này là điều kiện chất lượng, không phải phép kiểm tra sống/chết.' },
      { text: 'Bật Backend maintenance nếu muốn đồng bộ nguồn và kiểm tra định kỳ. Run now chạy ngay một vòng; mục Reachable của maintenance là kết quả vòng kiểm tra nguồn gần nhất.' },
      { text: 'Chỉ bật proxy pool cho đăng ký khi đã có ít nhất một proxy Fast / Usable. Nếu không, chọn route Direct/System hoặc Client rõ ràng trước khi chạy.' }
    ]
  },
  {
    id: 'registration',
    title: 'Đăng ký một tài khoản bằng Tingamefi',
    intro: 'Luồng đăng ký có circuit breaker: lỗi mạng tạm thời có thể thử lại, còn lỗi AWS risk control hoặc bước mật khẩu bị từ chối sẽ dừng để tránh lặp request vô ích.',
    steps: [
      { text: 'Mở Đăng ký tài khoản và chọn Tingamefi Mail. Nhập API URL, Admin password và domain mail.tingamefi.com, sau đó kiểm tra nguồn mạng đang là Direct/System, Proxy Pool hoặc Client theo đúng ý định.' },
      { text: 'Chạy một tài khoản trước. Theo dõi timeline: tạo email, mở workflow, gửi OTP, nhận OTP, đặt mật khẩu, lấy token và import tài khoản.' },
      { text: 'Với batch, bắt đầu concurrency 1 và retry 0 hoặc 1. Krouter không retry lỗi terminal như AWS risk control, TES/BLOCKED và lỗi đặt mật khẩu.' },
      { text: 'Sau khi thành công, vào Tài khoản kiểm tra email mới, token, quota và trạng thái. Analytics mặc định thu gọn; bấm Chi tiết để xem xu hướng và nhóm lỗi.' }
    ]
  },
  {
    id: 'skills',
    title: 'Dùng Skills Library và krouter-image',
    intro: 'Skills Library chứa hướng dẫn tích hợp đã bám theo endpoint đang chạy. krouter-image gọi API tạo ảnh tương thích OpenAI tại /v1/images/generations.',
    steps: [
      { text: 'Bật Proxy API và tạo API key. Mở Skills Library, chọn krouter-image và kiểm tra lệnh Quick Start dùng đúng host, port và key hiện tại.' },
      { text: 'Muốn dùng ChatGPT image, mở Routing Control Room > ChatGPT OAuth và bấm Connect ChatGPT. Với môi trường headless, gọi POST /auth/chatgpt/login kèm API key, mở authUrl rồi kiểm tra GET /auth/chatgpt/status. Đây là luồng ChatGPT/Codex và backend ChatGPT upstream, không phải OpenAI Images API công khai; không đưa token OAuth vào prompt hoặc log.' },
      { text: 'Gọi POST http://127.0.0.1:5580/v1/images/generations với prompt, size, quality và response_format. Dùng model nova-canvas khi Bedrock đã cấu hình ở vùng hỗ trợ (ví dụ ap-northeast-1, eu-west-1 hoặc us-east-1); Krouter không tự đổi vùng dữ liệu.' },
      { text: 'Với response_format=url, tải URL trong data[0].url và xác nhận Content-Type là image/*. Với b64_json, decode data[0].b64_json thành file ảnh.' }
    ]
  },
  {
    id: 'troubleshooting',
    title: 'Xử lý fetch failed và lỗi kết nối',
    intro: 'fetch failed là lỗi transport tổng quát. Hãy xác định nó xảy ra ở dashboard, proxy, DNS MITM hay upstream trước khi đổi tài khoản.',
    steps: [
      { text: 'Kiểm tra Proxy API đang Running và gọi GET http://127.0.0.1:5580/health. Nếu health lỗi, xem log backend và kiểm tra port 5580 có bị ứng dụng khác chiếm.' },
      { text: 'Nếu chỉ MITM lỗi, xác nhận HTTPS Interceptor đang Listening :443, CA là Trusted và chỉ DNS profile cần test đang bật. Tắt DNS Redirect trước khi dừng listener.' },
      { text: 'Nếu fetch tài khoản/model lỗi, mở Diagnostics và Request Logs để xem URL, status và cause. Krouter chỉ fallback direct một lần cho lỗi mạng phù hợp; lỗi HTTP thật vẫn được trả nguyên nhân.' },
      { text: 'Kiểm tra proxy hệ thống, upstream relay, DNS và firewall. Thử health bằng direct network trước; sau đó bật lại từng lớp một để tìm đúng điểm hỏng.' },
      { text: 'Không xóa tài khoản hoặc tăng retry hàng loạt khi chưa biết nguyên nhân. Với 401/403/429, đọc chẩn đoán và thời gian cooldown thay vì lặp request ngay.' }
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
