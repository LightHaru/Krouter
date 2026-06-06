# Krouter

Krouter la dashboard web va CLI router de quan ly tai khoan Kiro, dong bo credential va chay API proxy tuong thich OpenAI/Claude voi xoay vong nhieu tai khoan.

## Tinh nang chinh

- Dashboard web cho tai khoan, nhom, tag, ma may, dang ky, chan doan, proxy pool va cau hinh API proxy.
- Backend chay rieng voi frontend de API proxy on dinh hon khi dung localhost hoac tunnel public.
- Lenh `krouter` cho trang thai, tunnel dashboard, danh sach model, import OpenClaw va setup lan dau.
- API proxy xoay vong/chia tai khoan, cap nhat model catalog, log request va quan ly API key.
- Import OpenClaw bang provider `krouter`.
- Setup admin lan dau voi 2 lua chon: Krouter tao mat khau random hoac nguoi dung tu dat mat khau.

## Cai nhanh

```bash
npm install
npm run build:fullstack
npm run start:backend
```

Mo dashboard tu URL backend in ra. Lan dau chay, tao mat khau admin tren web hoac chay:

```bash
npm run cli -- setup
```

Sau khi setup:

```bash
krouter
krouter status
krouter tunnel start
krouter openclaw import
```

## License

AGPL-3.0.
