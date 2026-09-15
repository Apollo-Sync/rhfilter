// ─── Thông báo Telegram ────────────────────────────────────────────────────
// Gửi tin nhắn Telegram mỗi khi tìm thấy token đạt đủ điều kiện (cùng lúc
// với việc in ra log). Cấu hình đọc từ file telegram.txt đặt cùng cấp với
// package.json (giống cách rpc.txt được đọc trong config.mjs), gồm 2 dòng:
//
//   <BOT_TOKEN>
//   <CHAT_ID>
//
// Ví dụ nội dung telegram.txt:
//   123456789:AAExampleTokenFromBotFather
//   987654321
//
// Dòng trống hoặc bắt đầu bằng "#" sẽ bị bỏ qua. BOT_TOKEN lấy từ
// @BotFather (/newbot). CHAT_ID lấy bằng cách nhắn thử 1 tin cho bot rồi mở
// https://api.telegram.org/bot<TOKEN>/getUpdates để đọc "chat":{"id":...}.
// Nếu không tìm thấy file, hoặc file thiếu 1 trong 2 dòng, tính năng
// Telegram sẽ tự động tắt (không báo lỗi, không làm gián đoạn radar).
import fs from 'fs';

const TELEGRAM_CONFIG_FILE = 'telegram.txt';

function loadTelegramConfig() {
  try {
    const data = fs.readFileSync(TELEGRAM_CONFIG_FILE, 'utf8');
    const lines = data
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));

    const [botToken, chatId] = lines;
    if (botToken && chatId) return { botToken, chatId };

    console.log(
      `[*] Telegram: file ${TELEGRAM_CONFIG_FILE} thiếu bot token hoặc chat id -> bỏ qua thông báo Telegram.`
    );
  } catch (e) {
    console.log(
      `[*] Telegram: không tìm thấy ${TELEGRAM_CONFIG_FILE} -> bỏ qua thông báo Telegram.`
    );
  }
  return null;
}

const telegramConfig = loadTelegramConfig();
const BOT_TOKEN = telegramConfig?.botToken || "";
const CHAT_ID = telegramConfig?.chatId || "";

export const telegramEnabled = Boolean(BOT_TOKEN && CHAT_ID);

const API_URL = telegramEnabled
  ? `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`
  : null;
const GET_ME_URL = telegramEnabled
  ? `https://api.telegram.org/bot${BOT_TOKEN}/getMe`
  : null;

// Kiểm tra kết nối Telegram lúc khởi động: gọi API getMe (xác thực bot
// token còn sống) rồi thử gửi luôn 1 tin nhắn test tới CHAT_ID (xác thực
// chat id đúng, bot có quyền gửi vào đó). In kết quả rõ ràng ra terminal để
// biết ngay lúc chạy radar chứ không phải đợi tới khi có token mới biết
// Telegram có hoạt động hay không.
export async function verifyTelegramConnection() {
  if (!telegramEnabled) {
    console.log("[-] Telegram: TẮT (không tìm thấy telegram.txt hợp lệ).");
    return false;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(GET_ME_URL, { signal: controller.signal });
    const data = await res.json().catch(() => null);

    if (!res.ok || !data?.ok) {
      console.log(
        `[-] Telegram: BOT_TOKEN không hợp lệ (HTTP ${res.status}${data?.description ? ` - ${data.description}` : ""}). Kiểm tra lại dòng 1 trong telegram.txt.`
      );
      return false;
    }

    const botName = data.result?.username ? `@${data.result.username}` : "(không rõ tên)";

    const sent = await sendTelegramMessage(
      `✅ hood-radar đã kết nối Telegram thành công (bot ${botName}).`
    );

    if (sent) {
      console.log(`[+] Telegram: kết nối THÀNH CÔNG - bot ${botName}, đã gửi tin nhắn test tới chat_id=${CHAT_ID}.`);
      return true;
    } else {
      console.log(
        `[-] Telegram: bot token hợp lệ (${botName}) nhưng GỬI TIN THẤT BẠI tới chat_id=${CHAT_ID}. Kiểm tra lại dòng 2 trong telegram.txt (chat id) và đảm bảo đã nhắn/thêm bot vào chat đó trước.`
      );
      return false;
    }
  } catch (e) {
    console.log(`[-] Telegram: không kết nối được (${e.message}). Kiểm tra lại mạng hoặc telegram.txt.`);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

// Escape các ký tự đặc biệt của HTML parse_mode trong Telegram Bot API
// (<, >, &) - bắt buộc phải escape để tránh lỗi "can't parse entities" khi
// symbol/name của token chứa ký tự đó.
export function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Gửi 1 tin nhắn text tới chat đã cấu hình. Không throw ra ngoài - lỗi
// mạng/API chỉ được log ra console, không được phép làm crash vòng lặp
// chính của radar (xem cách gọi ở notifier.mjs: luôn có .catch()).
export async function sendTelegramMessage(text) {
  if (!telegramEnabled) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[-] Telegram gửi lỗi (HTTP ${res.status}): ${body}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[-] Telegram gửi lỗi: ${e.message}`);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

// Dựng nội dung tin nhắn Telegram cho 1 token vừa được báo (dùng HTML,
// không dùng mã màu ANSI như bản in ra console). Nhận cùng bộ tham số với
// printAlert() trong notifier.mjs để tái dùng logic format.
export function buildTelegramAlert({
  token,
  log,
  launch,
  meta,
  info,
  stats,
  devDumpPct,
  settings,
  fmtPct,
  quoteSymbol,
  STOCK_QUOTES,
  now,
}) {
  const liq = info?.liq || 0;
  const mc = info?.mc || 0;
  const quote = quoteSymbol(launch.pairToken) || info?.quoteSym || null;

  const sym = info?.sym || meta?.symbol || "?";
  const name = info?.name || meta?.name || "";
  const twitter = meta?.twitter || info?.twitter || null;
  const telegramLink = meta?.telegram || info?.telegram || null;
  const website = meta?.website || info?.website || null;

  const lines = [];
  lines.push(`🆕 <b>New Listing (GMGN)</b>   $${escapeHtml(sym)}  ${escapeHtml(name)}`);
  lines.push(`<b>CA</b>: <code>${escapeHtml(token)}</code>`);
  lines.push(`<b>Curve</b>: <code>${escapeHtml(launch.curve)}</code>`);
  lines.push(`<b>Deployer</b>: <code>${escapeHtml(launch.deployer)}</code>`);
  lines.push(`<b>Tx</b>: <code>${escapeHtml(log.transactionHash)}</code>`);
  lines.push(`<b>Block</b>: ${parseInt(log.blockNumber, 16)}`);
  lines.push(
    info
      ? `<b>Liq</b>: $${liq.toLocaleString("en-US")} (${escapeHtml(info.source)})`
      : `<b>Liq</b>: chưa index (token còn trên bonding curve)`
  );
  lines.push(`<b>MC/FDV</b>: $${mc.toLocaleString("en-US")}`);
  lines.push(`<b>Holders</b>: ${stats?.holders ?? "n/a"}`);
  lines.push(`<b>Top10</b>: ${fmtPct(stats?.top10)}`);
  lines.push(`<b>Snipers</b>: ${stats?.snipers ?? "n/a"}`);
  lines.push(`<b>Dev hold</b>: ${fmtPct(stats?.devPct)}`);
  if (twitter) lines.push(`<b>X</b>: ${escapeHtml(twitter)}`);
  if (telegramLink) lines.push(`<b>Telegram</b>: ${escapeHtml(telegramLink)}`);
  if (website) lines.push(`<b>Web</b>: ${escapeHtml(website)}`);
  lines.push(`<b>GMGN</b>: https://gmgn.ai/robinhood/token/${token}`);

  if (settings?.minAliveSec > 0) {
    lines.push(`✅ Alive ≥ ${settings.minAliveSec}s`);
  }
  if (settings?.requireDevDumped) {
    const pctStr = devDumpPct != null ? `${devDumpPct.toFixed(2)}%` : "n/a";
    lines.push(`✅ DevDump: dev còn giữ ${pctStr}`);
  }

  if (quote && STOCK_QUOTES.includes(quote.toUpperCase())) {
    lines.push(`⚡ Pair: $${escapeHtml(sym)}/${escapeHtml(quote)} (bám tin ${escapeHtml(quote)})`);
  } else if (quote) {
    lines.push(`Pair: $${escapeHtml(sym)}/${escapeHtml(quote)}`);
  }

  return lines.join("\n");
}
