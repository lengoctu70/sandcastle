# Cài đặt Sandcastle

Hướng dẫn cho người mới — chỉ cần copy–paste các câu lệnh bên dưới là cài và chạy được. Không cần clone repo này: Sandcastle được phát hành trên npm dưới tên `@lengoctu70/sandcastle`.

## Bước 0 — Kiểm tra yêu cầu (cài một lần)

Chạy 4 lệnh này để biết máy bạn đã sẵn sàng chưa:

```bash
node --version     # cần >= 18
git --version
gh --version       # GitHub CLI
gh auth status     # phải báo "Logged in to github.com"
```

Thiếu cái nào thì cài cái đó:

| Yêu cầu         | Cài bằng                                                               | Ghi chú                                                            |
| --------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Node.js ≥ 18    | https://nodejs.org/ hoặc `brew install node`                           | Bắt buộc                                                           |
| Git             | https://git-scm.com/ hoặc `brew install git`                           | Bắt buộc                                                           |
| GitHub CLI      | https://cli.github.com/ hoặc `brew install gh`, rồi `gh auth login`    | Bắt buộc — Sandcastle đọc/đóng issue qua `gh`                      |
| Agent CLI       | Claude Code, Codex, Devin, Cursor, Copilot, Grok… đã **đăng nhập** sẵn | Bắt buộc — tái sử dụng subscription của bạn, **không cần API key** |
| Docker / Podman | https://www.docker.com/ hoặc https://podman.io/                        | Không bắt buộc — chỉ khi muốn agent chạy trong container           |

## Bước 1 — Cài từ npm

Mở terminal trong repo bạn muốn Sandcastle làm việc, rồi chọn **một** trong 3 cách:

**Cách A — khuyến nghị:** cài vào repo như dev dependency:

```bash
npm i -D @lengoctu70/sandcastle
```

**Cách B — không cần cài:** chạy thẳng bằng `npx` (npm tự tải về):

```bash
npx @lengoctu70/sandcastle --version
```

**Cách C — cài global:** để gọi `sandcastle` ở bất cứ đâu:

```bash
npm i -g @lengoctu70/sandcastle
sandcastle --version
```

Kiểm tra cài đặt thành công:

```bash
npx @lengoctu70/sandcastle --version   # in ra phiên bản, ví dụ: 0.12.0
npx @lengoctu70/sandcastle --help      # liệt kê các lệnh: init, run, status, retry, discard…
```

## Bước 2 — Khởi tạo trong repo

```bash
npx @lengoctu70/sandcastle init
```

Init hỏi bạn bằng tiếng Việt: nơi chạy agent (`host` / `docker` / `podman`), agent + model + effort, workflow, issue tracker (`github-issues`), và các lệnh xác minh. Xong init tự thêm script `"sandcastle": "sandcastle run"` vào `package.json`.

## Bước 3 — Chạy

Trên GitHub, gắn label `Sandcastle` cho issue bạn muốn giao, rồi:

```bash
npm run sandcastle
```

Chọn một issue, hoặc chạy tất cả tuần tự / song song. Sandcastle tự implement → xác minh → merge → báo cáo tiếng Việt → đóng issue.

## Gặp lỗi?

| Lỗi                                         | Cách sửa                                                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `npm ERR! 404 Not Found`                    | `npm config get registry` phải trả về `https://registry.npmjs.org/`                                      |
| `command not found: sandcastle`             | Dùng `npx @lengoctu70/sandcastle …`, hoặc cài global (`npm i -g @lengoctu70/sandcastle`)                 |
| `npx sandcastle …` chạy một tool sandbox lạ | Trên npm có sẵn package `sandcastle` không liên quan — luôn ghi đủ scope: `npx @lengoctu70/sandcastle …` |
| `gh` chưa đăng nhập                         | `gh auth login` rồi chạy lại `npx @lengoctu70/sandcastle init`                                           |
| Agent chưa đăng nhập                        | Mở agent CLI (vd `claude`, `codex`) và đăng nhập trước                                                   |
| `node --version` < 18                       | Nâng cấp Node.js từ https://nodejs.org/                                                                  |
| Muốn cài bản mới nhất                       | `npm i -D @lengoctu70/sandcastle@latest` (hoặc `npm i -g …@latest` nếu global)                           |

Đọc thêm: [README.md](./README.md) — hướng dẫn đầy đủ, API, sandbox providers, CLI options.
