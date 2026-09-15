// ─── Bộ quản lý màn hình dùng chung (bản 2 DÒNG CỐ ĐỊNH) ──────────────────
// LỊCH SỬ CÁC BẢN TRƯỚC (để hiểu vì sao bản này được thiết kế thế này):
// 1. Ban đầu mỗi module (rpcClient, logs, notifier) tự dùng \r ghi đè "dòng
//    cuối" độc lập với nhau -> giẫm lên nhau, dòng bị khoá cứng vĩnh viễn
//    khi có log khác chen ngang.
// 2. Gộp thành 1 module dùng \x1b[0J qua nhiều lệnh write() rời rạc -> vẫn
//    lệch vị trí khi nhiều lệnh ghi liên tiếp bị tách/đệm không đúng thứ tự.
// 3. Dùng kỹ thuật "xoá N dòng vật lý, lùi con trỏ lên trên" với N là 1
//    BIẾN ĐẾM động (ước lượng theo bề rộng terminal) -> chỉ cần lệch 1 lần
//    là toàn bộ phần "vẽ đè" lệch VĨNH VIỄN từ đó về sau.
// 4. Gộp TẤT CẢ khu vực (rpc/scan/tracking) vào ĐÚNG 1 DÒNG DUY NHẤT, cắt
//    bớt (…) nếu quá dài -> KHÔNG còn lệch dòng nữa, nhưng phát sinh lỗi
//    MỚI: khi nhiều khu vực cùng có nội dung dài (vd đang quét block dồn
//    dập + đang theo dõi nhiều token), dòng ghép quá dài bị cắt cụt, mất
//    thông tin quan trọng ở cuối (vd "chờ bao nhiêu giây", "bỏ qua bao
//    nhiêu token") — đúng như bug bạn gặp.
//
// Bản này: quay lại 2 dòng, nhưng số dòng là HẰNG SỐ CỐ ĐỊNH = 2 (không
// phải biến đếm), nên không có gì để đếm sai/lệch cả — luôn luôn xoá đúng
// 2 dòng, luôn luôn vẽ lại đúng 2 dòng, mãi mãi, bất kể chạy bao lâu.
// - DÒNG 1: trạng thái RPC (nếu đang lỗi) HOẶC trạng thái quét block.
// - DÒNG 2: trạng thái theo dõi/bỏ qua token.
// Mỗi dòng có full bề rộng riêng để hiển thị hết thông tin, không còn phải
// chia sẻ bề rộng với khu vực khác như bản trước.
const isTTY = process.env.PLAIN_LOG === "1" ? false : true;
// `process.stdout.isTTY` từng được dùng để tự phát hiện terminal thật,
// nhưng khi chạy qua `npm start` trên một số máy Windows, npm bọc lệnh chạy
// qua 1 lớp trung gian khiến cờ này báo sai `false` dù vẫn đang chạy trong
// terminal bình thường. Giờ MẶC ĐỊNH LUÔN coi là terminal thật; đặt biến
// môi trường PLAIN_LOG=1 nếu bạn thật sự ghi log ra file (vd `npm start >
// log.txt`) và không muốn mã màu/escape code lẫn vào file.

const ESC = "\x1b";
const CLEAR_LINE = `${ESC}[2K`;
// Chuỗi xoá 2 dòng cố định: xoá dòng hiện tại (dòng 2, nơi con trỏ đang
// đứng sau lần vẽ trước) -> lên 1 dòng (dòng 1) -> xoá dòng đó -> về cột 1.
// Luôn GIỐNG HỆT NHAU ở mọi lần gọi vì số dòng luôn là hằng số 2.
const ERASE_TWO_LINES = `${ESC}[2K${ESC}[1A${ESC}[2K${ESC}[G`;
const ANSI_TOKEN_RE = /^\x1b\[[0-9;]*m/;

// Mã điểm (code point) không chiếm chỗ khi hiển thị: variation selector
// (vd FE0F đi kèm sau nhiều emoji như "⏭️"), zero-width joiner (ghép emoji),
// và các dấu tổ hợp (combining marks).
function isZeroWidthCodePoint(cp) {
  return cp === 0xfe0f || cp === 0x200d || (cp >= 0x0300 && cp <= 0x036f);
}

// Cắt chuỗi `str` (có thể chứa mã màu ANSI) cho vừa đúng `maxWidth` cột hiển
// thị, KHÔNG cắt đứt giữa 1 mã màu ANSI hay giữa 1 cặp surrogate (emoji).
// Trả về bản đã cắt kèm dấu "…" nếu có cắt bớt. Mỗi dòng trong 2 dòng cố
// định giờ được cắt ĐỘC LẬP với bề rộng riêng của nó (không còn phải chia
// sẻ bề rộng với khu vực khác như bản 1-dòng trước đây).
function truncateToWidth(str, maxWidth) {
  let out = "";
  let width = 0;
  let i = 0;
  let didCut = false;

  while (i < str.length) {
    const rest = str.slice(i, i + 8);
    const ansiMatch = rest.match(ANSI_TOKEN_RE);
    if (ansiMatch) {
      out += ansiMatch[0];
      i += ansiMatch[0].length;
      continue;
    }

    const cp = str.codePointAt(i);
    const unitLen = cp > 0xffff ? 2 : 1; // số UTF-16 code unit mà ký tự này chiếm
    const cw = isZeroWidthCodePoint(cp) ? 0 : (cp > 0xffff ? 2 : 1);

    if (width + cw > maxWidth) {
      didCut = true;
      break;
    }

    out += str.slice(i, i + unitLen);
    width += cw;
    i += unitLen;
  }

  if (!didCut) return str;

  // Chừa đúng 1 cột cho dấu "…"
  while (width > Math.max(0, maxWidth - 1) && out.length > 0) {
    out = out.slice(0, -1);
    width -= 1;
  }
  return out + "…";
}

// key -> text (có thể có màu ANSI). Mỗi key được gán CỐ ĐỊNH vào 1 trong 2
// dòng qua LINE_SLOTS bên dưới — việc gán này KHÔNG đổi theo thời gian hay
// theo thứ tự set, nên không có chuyện "nhảy dòng" giữa các lần vẽ.
const sections = new Map();

// Thứ tự ưu tiên các key trong TỪNG dòng: dòng đó sẽ hiển thị text của key
// ĐẦU TIÊN (theo thứ tự liệt kê) đang có nội dung. Ví dụ dòng 1: nếu 'rpc'
// đang có lỗi thì ưu tiên hiện lỗi RPC (quan trọng hơn), không thì hiện
// tiến độ quét block ('scan'). Dòng 2 chỉ có 1 key ('tracking').
const LINE_SLOTS = [
  ["rpc", "scan"],   // Dòng 1
  ["tracking"],      // Dòng 2
];

function buildLine(slotKeys) {
  const maxWidth = Math.max(1, (process.stdout.columns || 80) - 1);
  for (const key of slotKeys) {
    const text = sections.get(key);
    if (text) return truncateToWidth(text, maxWidth);
  }
  return "";
}

function buildLines() {
  return LINE_SLOTS.map(buildLine);
}

// true kể từ lần vẽ đầu tiên trở đi -> biết là đã có sẵn 2 dòng trên màn
// hình để mà xoá trước khi vẽ lại. Lần vẽ ĐẦU TIÊN không cần xoá gì cả.
let hasDrawn = false;

function drawLines() {
  if (!isTTY) return;
  const [line1, line2] = buildLines();
  const erase = hasDrawn ? ERASE_TWO_LINES : "";
  process.stdout.write(erase + line1 + "\n" + line2);
  hasDrawn = true;
  lastDrawTs = Date.now();
}

// Gộp mọi yêu cầu vẽ lại vào 1 hàng đợi, chỉ thực sự ghi ra terminal tối đa
// 1 lần mỗi REDRAW_THROTTLE_MS — tránh ghi dồn dập khi nhiều nguồn (quét
// block, theo dõi token, trạng thái RPC...) đổi trạng thái gần như cùng lúc
// (vd lúc quét bù backlog sau khi RPC vừa hồi phục).
const REDRAW_THROTTLE_MS = 150;
let lastDrawTs = 0;
let pendingTimer = null;

function scheduleDraw() {
  if (!isTTY) return;
  if (pendingTimer) return; // đã có 1 lượt vẽ sắp diễn ra, sẽ tự lấy state mới nhất khi tới lượt
  const elapsed = Date.now() - lastDrawTs;
  if (elapsed >= REDRAW_THROTTLE_MS) {
    drawLines();
  } else {
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      drawLines();
    }, REDRAW_THROTTLE_MS - elapsed);
  }
}

/**
 * Cập nhật nội dung 1 "khu vực" động (vd: 'rpc', 'scan', 'tracking'). Mỗi
 * khu vực được gán cố định vào 1 trong 2 dòng qua LINE_SLOTS ở trên, nên
 * giờ luôn có ĐỦ CHỖ RIÊNG để hiển thị hết thông tin, không bị khu vực khác
 * chiếm chỗ / cắt cụt như bản 1-dòng trước đây.
 * Nhận cả string đơn lẫn mảng string (mảng sẽ được nối lại bằng dấu cách)
 * để tương thích với các nơi gọi cũ đang truyền mảng.
 * Truyền chuỗi rỗng / mảng rỗng / null để xoá hẳn khu vực đó.
 */
export function setSection(key, textOrLines) {
  const text = Array.isArray(textOrLines) ? textOrLines.join(" ") : (textOrLines || "");
  if (!isTTY) {
    // Không phải TTY thật (vd log ra file): không thể "vẽ lại tại chỗ", chỉ
    // in ra khi có nội dung mới để không mất thông tin trong log file.
    if (text) process.stdout.write(text + "\n");
    return;
  }
  if (!text) {
    sections.delete(key);
  } else {
    sections.set(key, text);
  }
  scheduleDraw();
}

/**
 * In 1 đoạn log "vĩnh viễn" (không bị 2 dòng động ghi đè, có thể nhiều dòng
 * nối bằng '\n'). Xoá đúng 2 dòng động hiện tại, in nội dung (kết thúc bằng
 * '\n' thật để nó ở lại vĩnh viễn trong scrollback), rồi vẽ lại 2 dòng động
 * ngay bên dưới — tất cả gộp trong 1 lệnh ghi duy nhất.
 *
 * Luôn vẽ NGAY (bỏ qua hàng đợi throttle) vì đây là nội dung quan trọng,
 * xảy ra 1 lần (vd New Listing, RPC OK) — không được phép trì hoãn.
 */
export function printPermanent(text) {
  if (!isTTY) {
    process.stdout.write(text + "\n");
    return;
  }
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  const [line1, line2] = buildLines();
  const erase = hasDrawn ? ERASE_TWO_LINES : "";
  process.stdout.write(erase + text + "\n" + line1 + "\n" + line2);
  hasDrawn = true;
  lastDrawTs = Date.now();
}
