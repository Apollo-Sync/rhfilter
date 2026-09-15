import { RPC_LIST } from './config.mjs';
import { setSection, printPermanent } from './screen.mjs';

let currentRpcIndex = 0;

// RPC nào vừa lỗi sẽ bị "nghỉ" (cooldown) trong khoảng thời gian này trước khi
// được thử lại — tránh việc cứ mỗi lượt gọi rpc() lại đập vào RPC đã biết chết,
// vừa tốn quota vừa spam log không cần thiết.
const RPC_COOLDOWN_MS = 60_000;
const cooldownUntil = new Map(); // url -> timestamp (ms) hết hạn nghỉ

// ─── Trạng thái RPC: gộp MỌI lỗi RPC (dù bao nhiêu request đang lỗi cùng
// lúc) thành DUY NHẤT 1 dòng động (khu vực 'rpc' trong screen.mjs) thay vì in
// một dòng mới cho mỗi lần lỗi. Khi RPC lỗi -> dòng màu đỏ "RPC đang lỗi...".
// Khi RPC đã ổn định trở lại (không còn lỗi nào trong một khoảng thời gian)
// -> chốt 1 dòng xanh "RPC OK" (in vĩnh viễn qua printPermanent) và xoá dòng
// động màu đỏ đi.
//
// Trước đây việc này dùng \r ghi đè trực tiếp lên "dòng cuối" của terminal,
// nên bất kỳ dòng log nào khác (quét block, theo dõi token, alert...) xen
// vào giữa cũng khiến dòng lỗi bị "khoá cứng" thành dòng vĩnh viễn -> lỗi cứ
// lặp lại vô số dòng đỏ dù RPC vẫn ở cùng 1 trạng thái. Nay đi qua screen.mjs
// (khu vực riêng luôn được vẽ lại đúng vị trí, không bị các log khác chen
// ngang) nên chỉ còn đúng 1 dòng lỗi tại một thời điểm.
//
// LƯU Ý QUAN TRỌNG: có rất nhiều request RPC chạy song song (mỗi token đang
// theo dõi gọi RPC độc lập). Nếu chỉ cần đúng 1 request thành công là lập
// tức báo "OK" ngay, trong khi các request khác cùng lúc vẫn đang lỗi, thì
// trạng thái đỏ/xanh sẽ nhảy qua lại liên tục -> mỗi lần chuyển trạng thái
// lại chốt thành 1 dòng cứng mới -> trông như bị spam nhiều dòng. Nên phải
// "debounce": chỉ thật sự chốt "OK" sau khi im ắng (không có lỗi mới) được
// một khoảng ổn định (RPC_OK_DEBOUNCE_MS), không phải ngay khi có 1 request
// may mắn thành công giữa lúc các request khác vẫn đang lỗi.
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

let rpcErrorActive = false;
let lastErrorText = "";
let lastRenderTime = 0;
let pendingRenderTimer = null;
let pendingOkTimer = null;
const RPC_STATUS_THROTTLE_MS = 1000;  // gộp mọi lỗi dồn dập trong 1s thành 1 lần vẽ
const RPC_OK_DEBOUNCE_MS = 3000;      // phải "im lỗi" liên tục 3s mới chốt OK

function drawRpcErrorLine() {
  const text = `[!] RPC đang lỗi (${getActiveRpc()}) - ${lastErrorText}`;
  setSection('rpc', [`${RED}${text}${RESET}`]);
}

function scheduleRpcErrorRender() {
  const elapsed = Date.now() - lastRenderTime;
  if (elapsed >= RPC_STATUS_THROTTLE_MS) {
    lastRenderTime = Date.now();
    drawRpcErrorLine();
  } else if (!pendingRenderTimer) {
    pendingRenderTimer = setTimeout(() => {
      pendingRenderTimer = null;
      lastRenderTime = Date.now();
      drawRpcErrorLine();
    }, RPC_STATUS_THROTTLE_MS - elapsed);
  }
}

// Gọi khi 1 request RPC bị lỗi (timeout / rate limit / trả lỗi...). Bất kỳ
// lỗi mới nào cũng hủy luôn bộ đếm "chuẩn bị chốt OK" đang chờ (nếu có) —
// vì vẫn còn ít nhất 1 RPC đang lỗi thì chưa thể coi là ổn định.
function markRpcError(msg) {
  lastErrorText = msg;
  rpcErrorActive = true;
  if (pendingOkTimer) {
    clearTimeout(pendingOkTimer);
    pendingOkTimer = null;
  }
  scheduleRpcErrorRender();
}

// Gọi khi 1 request RPC thành công. Nếu đang ở trạng thái lỗi, KHÔNG chốt
// "OK" ngay lập tức — mà đợi thêm RPC_OK_DEBOUNCE_MS xem có lỗi nào khác
// xen vào không (vì có thể vẫn còn nhiều request khác đang lỗi song song).
// Chỉ khi hết khoảng chờ đó mà không có lỗi mới nào -> mới thật sự chốt
// dòng "OK" (in 1 lần, xuống dòng). Nếu có lỗi mới xen vào trong lúc chờ,
// markRpcError() ở trên sẽ hủy timer này, tránh in "OK" hớ.
function markRpcOk() {
  if (!rpcErrorActive) return;
  if (pendingOkTimer) return; // đã có 1 bộ đếm đang chờ, không cần đặt lại
  pendingOkTimer = setTimeout(() => {
    pendingOkTimer = null;
    if (!rpcErrorActive) return;
    rpcErrorActive = false;
    if (pendingRenderTimer) {
      clearTimeout(pendingRenderTimer);
      pendingRenderTimer = null;
    }
    setSection('rpc', []); // xoá dòng lỗi động
    printPermanent(`${GREEN}[+] RPC OK${RESET}`);
  }, RPC_OK_DEBOUNCE_MS);
}

export function getActiveRpc() {
  return RPC_LIST[currentRpcIndex];
}

// Chỉ chuyển index, KHÔNG log ở đây nữa — việc log lỗi được xử lý tập trung
// trong rpc() để đảm bảo mọi lỗi RPC chỉ gộp vào đúng 1 dòng trạng thái.
export function rotateRpc() {
  currentRpcIndex = (currentRpcIndex + 1) % RPC_LIST.length;
}

// Hàm kiểm tra xem RPC có hoạt động hay không bằng cách gọi thử eth_blockNumber với timeout 5 giây
export async function checkRpc(url) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    const json = await res.json();
    if (json.result) return true;
  } catch (e) {
    // RPC lỗi hoặc quá hạn timeout
  }
  return false;
}

// Kiểm tra toàn bộ danh sách RPC và chọn ra RPC sống đầu tiên trước khi chạy chương trình
export async function initRpc() {
  console.log("[*] Đang kiểm tra trạng thái các RPC...");
  for (let i = 0; i < RPC_LIST.length; i++) {
    const url = getActiveRpc();
    process.stdout.write(`    - Kiểm tra ${url} ... `);
    const isAlive = await checkRpc(url);
    if (isAlive) {
      console.log("\x1b[32mOK\x1b[0m");
      return true;
    } else {
      console.log("\x1b[31mĐơ/Lỗi\x1b[0m");
      rotateRpc();
    }
  }
  console.log("[-] Tất cả RPC trong danh sách đều không phản hồi!");
  return false;
}

export async function rpc(method, params = []) {
  let tries = 0;
  const maxTries = RPC_LIST.length;
  let lastError = null;

  while (tries < maxTries) {
    const currentUrl = getActiveRpc();
    const now = Date.now();
    const cooldownEnd = cooldownUntil.get(currentUrl);

    // RPC này vừa lỗi gần đây và còn đang trong thời gian nghỉ -> bỏ qua
    // âm thầm (không log, không gọi thật) để tránh spam + tốn quota vô ích.
    if (cooldownEnd && now < cooldownEnd) {
      tries++;
      rotateRpc();
      continue;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 7000);

      const res = await fetch(currentUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      const json = await res.json();
      if (json.error) {
        throw new Error(json.error.message || "rpc error");
      }

      cooldownUntil.delete(currentUrl); // RPC đã sống lại -> xóa cooldown nếu có
      markRpcOk();
      return json.result;
    } catch (e) {
      lastError = e;
      // Không console.log riêng từng lỗi nữa — gộp mọi lỗi (kể cả nhiều
      // request lỗi cùng lúc) vào đúng 1 dòng trạng thái duy nhất.
      markRpcError(`${currentUrl} - ${e.message}`);
      cooldownUntil.set(currentUrl, Date.now() + RPC_COOLDOWN_MS);

      tries++;
      rotateRpc();
      if (tries >= maxTries) {
        throw new Error(`Tất cả RPC trong rpc.txt đều lỗi: ${lastError.message}`);
      }
    }
  }
}

export async function latestBlock() {
  return parseInt(await rpc("eth_blockNumber"), 16);
}