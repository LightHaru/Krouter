/**
 * Vietnamese translations used as the single UI language for Krouter.
 * common.unknown intentionally remains "Unknown" because legacy components use it
 * as a boolean sentinel to choose the non-Chinese render branch.
 */

const en = {
  common: {
    confirm: 'Xác nhận',
    cancel: 'Hủy',
    save: 'Lưu',
    delete: 'Xóa',
    edit: 'Sửa',
    add: 'Thêm',
    close: 'Đóng',
    loading: 'Đang tải...',
    success: 'Thành công',
    error: 'Lỗi',
    warning: 'Cảnh báo',
    info: 'Thông tin',
    yes: 'Có',
    no: 'Không',
    enabled: 'Đã bật',
    disabled: 'Đã tắt',
    all: 'Tất cả',
    none: 'Không có',
    search: 'Tìm kiếm',
    filter: 'Lọc',
    sort: 'Sắp xếp',
    refresh: 'Làm mới',
    copy: 'Sao chép',
    copied: 'Đã sao chép',
    import: 'Nhập',
    export: 'Xuất',
    backup: 'Sao lưu',
    restore: 'Khôi phục',
    reset: 'Đặt lại',
    apply: 'Áp dụng',
    selected: 'Đã chọn',
    total: 'Tổng',
    unknown: 'Unknown'
  },

  nav: {
    home: 'Trang chính',
    accounts: 'Tài khoản',
    machineId: 'Mã máy',
    kiroSettings: 'Cài đặt Kiro',
    proxy: 'Proxy API',
    kproxy: 'K-Proxy',
    proxyPool: 'Kho proxy',
    webhooks: 'Webhook',
    diagnose: 'Chẩn đoán',
    configSync: 'Đồng bộ cấu hình',
    register: 'Đăng ký',
    subscription: 'Gói dịch vụ',
    logs: 'Nhật ký',
    settings: 'Cài đặt',
    about: 'Giới thiệu'
  },

  home: {
    title: 'Trang chính',
    totalAccounts: 'Tổng tài khoản',
    activeAccounts: 'Đang hoạt động',
    errorAccounts: 'Có lỗi',
    totalQuota: 'Tổng hạn mức',
    currentAccount: 'Tài khoản hiện tại',
    noCurrentAccount: 'Chưa chọn tài khoản',
    selectAccount: 'Chọn một tài khoản để sử dụng',
    subscription: 'Gói dịch vụ',
    usage: 'Mức sử dụng',
    daysRemaining: 'Còn {days} ngày',
    expiresOn: 'Hết hạn vào {date}',
    quickActions: 'Thao tác nhanh',
    switchAccount: 'Đổi tài khoản',
    refreshToken: 'Làm mới token',
    checkStatus: 'Kiểm tra trạng thái',
    welcome: {
      title: 'Chào mừng đến với Krouter',
      description: 'Công cụ quản lý nhiều tài khoản cho Kiro IDE',
      features: {
        multiAccount: 'Quản lý nhiều tài khoản Kiro',
        autoRefresh: 'Tự động làm mới token trước khi hết hạn',
        machineId: 'Quản lý mã máy để giảm lỗi liên kết tài khoản',
        themes: 'Có 32 màu giao diện'
      }
    }
  },

  accounts: {
    title: 'Quản lý tài khoản',
    addAccount: 'Thêm tài khoản',
    batchAdd: 'Thêm hàng loạt',
    searchPlaceholder: 'Tìm tài khoản...',
    noAccounts: 'Chưa có tài khoản',
    addFirstAccount: 'Thêm tài khoản đầu tiên để bắt đầu',
    totalAccounts: '{count} tài khoản',
    selectedCount: 'Đã chọn {count}',
    batchActions: 'Thao tác hàng loạt',
    setGroup: 'Gán nhóm',
    setTags: 'Gán thẻ',
    batchRefresh: 'Làm mới hàng loạt',
    batchCheck: 'Kiểm tra hàng loạt',
    batchDelete: 'Xóa hàng loạt',
    confirmDelete: 'Anh chắc chắn muốn xóa tài khoản này?',
    confirmBatchDelete: 'Anh chắc chắn muốn xóa {count} tài khoản?',
    filters: {
      all: 'Tất cả',
      active: 'Đang hoạt động',
      error: 'Có lỗi',
      expiring: 'Sắp hết hạn',
      noGroup: 'Chưa có nhóm'
    },
    sort: {
      email: 'Email',
      usage: 'Mức dùng',
      addedAt: 'Ngày thêm',
      lastChecked: 'Lần kiểm tra cuối'
    },
    card: {
      usage: 'Mức dùng',
      base: 'Cơ bản',
      trial: 'Dùng thử',
      tokenExpiry: 'Token: {time}',
      tokenExpired: 'Token: hết hạn',
      lastChecked: 'Đã kiểm tra: {time}',
      neverChecked: 'Chưa kiểm tra',
      switchTo: 'Chuyển sang tài khoản này',
      current: 'Hiện tại',
      banned: 'Bị khóa',
      verified: 'Đã xác minh'
    }
  },

  addAccount: {
    title: 'Thêm tài khoản',
    description: 'Thêm tài khoản Kiro mới',
    tabs: {
      ssoToken: 'SSO Token',
      oidcCredentials: 'Thông tin OIDC',
      socialLogin: 'Đăng nhập mạng xã hội',
      batchImport: 'Nhập hàng loạt'
    },
    ssoToken: {
      label: 'SSO Token',
      placeholder: 'Dán SSO Token vào đây...',
      hint: 'Lấy từ công cụ nhà phát triển của trình duyệt sau khi đăng nhập Kiro'
    },
    oidc: {
      authMethod: 'Phương thức xác thực',
      builderId: 'Builder ID (IdC)',
      social: 'GitHub / Google',
      refreshToken: 'Refresh Token',
      refreshTokenPlaceholder: 'Dán Refresh Token...',
      clientId: 'Client ID',
      clientSecret: 'Client Secret',
      region: 'Vùng AWS',
      socialHint: 'Đăng nhập mạng xã hội không cần Client ID và Client Secret',
      selectProvider: 'Chọn nhà cung cấp'
    },
    social: {
      title: 'Đăng nhập mạng xã hội',
      description: 'Đăng nhập bằng Google hoặc GitHub',
      google: 'Đăng nhập bằng Google',
      github: 'Đăng nhập bằng GitHub',
      waiting: 'Đang chờ cấp quyền...',
      success: 'Cấp quyền thành công!',
      failed: 'Cấp quyền thất bại'
    },
    batch: {
      title: 'Nhập hàng loạt',
      description: 'Nhập nhiều tài khoản cùng lúc',
      format: 'Định dạng: mỗi dòng một tài khoản',
      placeholder: 'refreshToken\nHOẶC\nrefreshToken,clientId,clientSecret\nHOẶC\nđịnh dạng JSON',
      importing: 'Đang nhập {current}/{total}...',
      result: 'Nhập xong: {success} thành công, {failed} lỗi'
    },
    verifying: 'Đang xác minh...',
    verifySuccess: 'Xác minh thành công',
    verifyFailed: 'Xác minh thất bại'
  },

  editAccount: {
    title: 'Sửa tài khoản',
    description: 'Chỉnh cài đặt tài khoản hoặc làm mới thông tin đăng nhập',
    nickname: 'Tên gợi nhớ',
    nicknamePlaceholder: 'Đặt tên dễ nhớ cho tài khoản này',
    credentials: 'Thông tin đăng nhập',
    socialCredentials: 'Thông tin đăng nhập mạng xã hội',
    oidcCredentials: 'Thông tin OIDC',
    importFromLocal: 'Nhập từ máy',
    verifyAndRefresh: 'Xác minh và làm mới',
    saveChanges: 'Lưu thay đổi',
    accountStatus: 'Trạng thái tài khoản',
    verified: 'Đã xác minh',
    error: 'Lỗi'
  },

  machineId: {
    title: 'Quản lý mã máy',
    description: 'Quản lý định danh thiết bị cho tài khoản',
    current: 'Mã máy hiện tại',
    original: 'Bản sao lưu gốc',
    noBackup: 'Chưa có sao lưu',
    backupTime: 'Thời gian sao lưu: {time}',
    actions: {
      copy: 'Sao chép',
      generate: 'Tạo ngẫu nhiên',
      custom: 'Tùy chỉnh',
      restore: 'Khôi phục mã gốc',
      backupToFile: 'Sao lưu ra file',
      restoreFromFile: 'Khôi phục từ file'
    },
    automation: {
      title: 'Cài đặt tự động',
      autoSwitch: 'Tự đổi mã máy',
      autoSwitchDesc: 'Tự đổi mã máy khi chuyển tài khoản',
      bindToAccount: 'Gắn mã máy theo tài khoản',
      bindToAccountDesc: 'Mỗi tài khoản dùng một mã máy riêng',
      useBinded: 'Dùng mã đã gắn',
      useBindedDesc: 'Dùng mã máy đã gắn khi chuyển tài khoản'
    },
    accountBindings: 'Mã máy đã gắn với tài khoản',
    history: 'Lịch sử thay đổi',
    requiresAdmin: 'Cần quyền quản trị viên',
    restartAsAdmin: 'Khởi động lại bằng quyền quản trị',
    platformInfo: {
      title: 'Thông tin nền tảng',
      windows: 'Windows: sửa MachineGuid trong registry',
      macos: 'macOS: sửa IOPlatformUUID',
      linux: 'Linux: sửa /etc/machine-id'
    }
  },

  settings: {
    title: 'Cài đặt',
    language: {
      title: 'Ngôn ngữ',
      description: 'Chọn ngôn ngữ hiển thị',
      auto: 'Tiếng Việt',
      en: 'Tiếng Việt',
      zh: 'Tiếng Việt',
      customFile: 'File dịch tùy chỉnh',
      loadCustom: 'Tải file',
      customHint: 'Tải file JSON dịch tùy chỉnh từ máy'
    },
    theme: {
      title: 'Giao diện',
      description: 'Tùy chỉnh hiển thị',
      color: 'Màu chủ đạo',
      darkMode: 'Chế độ tối',
      lightMode: 'Chế độ sáng'
    },
    privacy: {
      title: 'Quyền riêng tư',
      description: 'Cài đặt bảo vệ thông tin nhạy cảm',
      privacyMode: 'Chế độ riêng tư',
      privacyModeDesc: 'Ẩn email, token và các thông tin nhạy cảm'
    },
    autoRefresh: {
      title: 'Tự làm mới',
      description: 'Cài đặt tự làm mới token',
      enabled: 'Tự làm mới',
      enabledDesc: 'Tự làm mới token trước khi hết hạn và đồng bộ thông tin tài khoản',
      interval: 'Chu kỳ kiểm tra',
      intervalDesc: 'Tần suất kiểm tra trạng thái tài khoản',
      concurrency: 'Số luồng làm mới',
      concurrencyDesc: 'Số tài khoản được làm mới cùng lúc',
      syncInfo: 'Đồng bộ thông tin tài khoản',
      syncInfoDesc: 'Kiểm tra mức dùng, gói dịch vụ và trạng thái khóa khi làm mới token',
      minutes: '{n} phút'
    },
    autoSwitch: {
      title: 'Tự đổi tài khoản',
      description: 'Tự đổi tài khoản khi số dư thấp',
      enabled: 'Tự đổi',
      enabledDesc: 'Tự chuyển sang tài khoản khác khi tài khoản hiện tại còn ít hạn mức',
      threshold: 'Ngưỡng số dư',
      thresholdDesc: 'Chuyển khi số dư thấp hơn giá trị này',
      interval: 'Chu kỳ kiểm tra',
      intervalDesc: 'Tần suất kiểm tra số dư'
    },
    proxy: {
      title: 'Proxy',
      description: 'Cài đặt proxy mạng',
      enabled: 'Bật proxy',
      url: 'URL proxy',
      urlPlaceholder: 'http://host:port hoặc socks5://host:port',
      urlHint: 'Hỗ trợ HTTP, HTTPS, SOCKS5'
    },
    data: {
      title: 'Quản lý dữ liệu',
      description: 'Nhập/xuất dữ liệu tài khoản',
      export: 'Xuất dữ liệu',
      import: 'Nhập dữ liệu',
      exportHint: 'Xuất tài khoản sang JSON, TXT, CSV hoặc clipboard',
      importHint: 'Nhập tài khoản từ file JSON'
    },
    batchImport: {
      title: 'Nhập hàng loạt',
      concurrency: 'Số luồng nhập',
      concurrencyDesc: 'Số tài khoản nhập cùng lúc'
    },
    dangerZone: {
      title: 'Vùng nguy hiểm',
      clearData: 'Xóa toàn bộ dữ liệu',
      clearDataDesc: 'Xóa toàn bộ tài khoản và cài đặt',
      clearDataConfirm: 'Anh chắc chắn chứ? Thao tác này không thể hoàn tác.',
      clearDataButton: 'Xóa toàn bộ dữ liệu'
    }
  },

  about: {
    title: 'Giới thiệu',
    version: 'Phiên bản {version}',
    description: 'Công cụ quản lý nhiều tài khoản cho Kiro IDE',
    features: 'Tính năng',
    techStack: 'Công nghệ',
    author: 'Tác giả',
    github: 'GitHub',
    checkUpdate: 'Kiểm tra cập nhật',
    upToDate: 'Anh đang dùng phiên bản mới nhất',
    newVersion: 'Có phiên bản mới: {version}',
    download: 'Tải xuống',
    releaseNotes: 'Ghi chú phát hành'
  },

  status: {
    active: 'Hoạt động',
    error: 'Lỗi',
    banned: 'Bị khóa',
    expired: 'Hết hạn',
    unknown: 'Không rõ'
  },

  subscription: {
    free: 'Miễn phí',
    pro: 'Pro',
    enterprise: 'Enterprise',
    teams: 'Teams',
    unknown: 'Không rõ'
  },

  time: {
    justNow: 'Vừa xong',
    minutesAgo: '{n} phút trước',
    hoursAgo: '{n} giờ trước',
    daysAgo: '{n} ngày trước',
    expired: 'Đã hết hạn',
    remaining: 'Còn {time}'
  },

  errors: {
    networkError: 'Lỗi mạng, vui lòng kiểm tra kết nối',
    authError: 'Xác thực thất bại',
    tokenExpired: 'Token đã hết hạn, vui lòng làm mới',
    accountBanned: 'Tài khoản đã bị khóa',
    invalidCredentials: 'Thông tin đăng nhập không hợp lệ',
    importFailed: 'Nhập thất bại',
    exportFailed: 'Xuất thất bại',
    saveFailed: 'Lưu thất bại',
    loadFailed: 'Tải thất bại',
    unknownError: 'Đã xảy ra lỗi không xác định'
  },

  messages: {
    accountAdded: 'Đã thêm tài khoản',
    accountDeleted: 'Đã xóa tài khoản',
    accountUpdated: 'Đã cập nhật tài khoản',
    tokenRefreshed: 'Đã làm mới token',
    settingsSaved: 'Đã lưu cài đặt',
    dataCopied: 'Đã sao chép dữ liệu',
    dataExported: 'Đã xuất dữ liệu',
    dataImported: 'Đã nhập dữ liệu',
    machineIdChanged: 'Đã đổi mã máy',
    machineIdRestored: 'Đã khôi phục mã máy'
  },

  register: {
    title: 'Đăng ký tài khoản',
    mode: 'Chế độ đăng ký',
    manual: 'Thủ công',
    proxyLabel: 'Proxy (không bắt buộc)',
    proxyPlaceholder: 'socks5://127.0.0.1:1080',
    moApiUrl: 'URL API MoEmail',
    moApiKey: 'API Key',
    optional: 'không bắt buộc',
    outlookAccounts: 'Tài khoản Outlook',
    outlookFormat: 'email----mật khẩu----clientId----token',
    outlookPlaceholder: 'user@outlook.com----matkhau----clientId----refreshToken',
    tempmail: 'Tên miền riêng',
    tempMailDomain: 'Tên miền riêng',
    tempMailEmail: 'Tên đăng nhập TempMail.Plus',
    tempMailEmailPlaceholder: 'username (không gồm @mailto.plus)',
    tempMailEpin: 'PIN truy cập TempMail.Plus',
    tempMailDesc: 'Tên miền cần chuyển tiếp catch-all về hộp thư TempMail.Plus. Prefix email sẽ được tạo ngẫu nhiên.',
    emailLabel: 'Email',
    emailPlaceholder: 'ten@mien.com',
    fullNameLabel: 'Họ tên (không bắt buộc)',
    fullNamePlaceholder: 'Nguyễn Văn A',
    submitEmail: 'Gửi email',
    otpLabel: 'Mã xác minh',
    otpSentTo: 'Mã đã gửi đến',
    submitOtp: 'Gửi mã',
    startRegistration: 'Bắt đầu đăng ký',
    cancel: 'Hủy',
    newRegistration: 'Đăng ký mới',
    processing: 'Đang xử lý...',
    success: 'Đăng ký thành công',
    failed: 'Đăng ký thất bại',
    emailField: 'Email:',
    passwordField: 'Mật khẩu:',
    importToManager: 'Nhập vào trình quản lý',
    imported: 'Đã nhập',
    log: 'Nhật ký',
    logManualInit: 'Chế độ thủ công: đang khởi tạo OIDC + xác thực thiết bị...',
    logInitDone: 'Khởi tạo xong, vui lòng nhập email',
    logInitFailed: 'Khởi tạo thất bại:',
    logSubmitEmail: 'Đang gửi email:',
    logOtpSent: 'Đã gửi mã, vui lòng kiểm tra hộp thư',
    logFailed: 'Thất bại:',
    logSubmitOtp: 'Đang gửi mã:',
    logAutoStart: 'Chế độ tự động ({mode}) đang bắt đầu đăng ký...',
    logStartFailed: 'Khởi chạy thất bại:',
    logCancelled: 'Đã hủy',
    logRegSuccess: 'Đăng ký thành công! Email:',
    logRegFailed: 'Đăng ký thất bại:',
    logImported: 'Đã nhập tài khoản vào trình quản lý',
    logVerifyFailed: 'Xác minh thất bại:',
    logDirectImport: 'Đã nhập trực tiếp, cần làm mới thủ công',
    logImportFailed: 'Nhập thất bại:',
    fullNameRandom: 'Họ tên (bỏ trống sẽ tạo ngẫu nhiên)',
    parentEmailSection: 'Email chính và biến thể ẩn danh',
    parentEmailLabel: 'Email chính (nhận OTP)',
    parentEmailPlaceholder: 'ten-cua-anh@gmail.com',
    parentEmailHint: 'Không bắt buộc. Cần nhập khi bật ẩn danh; nếu không có thể nhập thủ công sau khi khởi tạo.',
    anonymousEmailLabel: 'Email ẩn danh ngẫu nhiên (biến thể dấu chấm)',
    anonymousEmailHint: 'Chèn dấu `.` vào phần tên email để tạo biến thể. Hệ thống kiểm tra danh sách tài khoản cục bộ để tránh trùng.',
    nextVariant: 'Biến thể tiếp theo',
    dotCount: 'Số dấu chấm',
    sameRoot: 'Đã dùng cùng gốc',
    anonymousNoParent: 'Vui lòng nhập email chính trước',
    anonymousInvalid: 'Định dạng email chính không hợp lệ',
    anonymousExhausted: 'Đã hết biến thể dấu chấm; hãy dùng email chính khác',
    logAnonymousNoParent: '[Ẩn danh] Email chính trống hoặc không hợp lệ, đã dừng',
    logAnonymousExhausted: '[Ẩn danh] Đã hết biến thể dấu chấm; hãy dùng email chính khác',
    logAnonymousGenerated: '[Ẩn danh] Đã tạo biến thể {email} ({dots} dấu chấm)',
    batchTitle: 'Đăng ký hàng loạt',
    batchCount: 'Số lượng',
    batchInterval: 'Khoảng cách (giây)',
    batchStart: 'Bắt đầu hàng loạt',
    batchStop: 'Dừng hàng loạt',
    batchProgress: 'Tiến độ',
    batchSuccess: 'Thành công',
    batchFail: 'Thất bại',
    historyTitle: 'Lịch sử đăng ký',
    historyEmpty: 'Chưa có bản ghi đăng ký',
    historyClear: 'Xóa lịch sử',
    historyTime: 'Thời gian',
    historyStatus: 'Trạng thái',
    historyImport: 'Nhập',
    batchAutoImport: 'Tự nhập',
    batchAutoImportDesc: 'Xác minh và nhập vào trình quản lý khi thành công',
    autoFetchProLink: 'Lấy link Pro',
    autoFetchProLinkDesc: 'Tự lấy link đăng ký Kiro Pro sau khi đăng ký',
    fetchingProLink: 'Đang lấy link đăng ký Pro',
    linkCopied: 'Đã sao chép link',
    batchRetries: 'Số lần thử lại',
    batchConcurrency: 'Số luồng',
    batchRetrying: 'Đang thử lại ({current}/{max})...',
    batchItemSuccess: 'Thành công',
    batchItemFailed: 'Thất bại',
    batchItemRetrying: 'Đang thử lại',
    batchItemImported: 'Đã nhập',
    batchItemImportFailed: 'Nhập thất bại',
    batchCompleted: 'Đăng ký hàng loạt đã hoàn tất',
    batchStopped: 'Đăng ký hàng loạt đã dừng tại {done}/{total}'
  }
}

export default en
