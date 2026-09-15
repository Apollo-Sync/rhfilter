import { rpc } from './rpcClient.mjs';
import { FACTORIES, TOPIC_TOKEN_LAUNCHED, CHUNK_SIZE } from './config.mjs';
import { now } from './format.mjs';
import { setSection } from './screen.mjs';

// Trước đây giữ 5 dòng lịch sử "Đang quét block" gần nhất, và vẽ lại màn
// hình mỗi khi quét xong 1 chunk (mặc định 5 block/chunk). Khi cần quét bù
// một lượng block lớn (ví dụ vòng lặp vừa bị chậm/khựng tạm thời rồi resume,
// phải quét bù hàng trăm block liên tiếp), số lần vẽ lại có thể lên tới
// hàng chục lần/giây. Sau khi chạy đủ lâu (màn hình đã cuộn qua rất nhiều
// nội dung), việc vẽ lại quá dồn dập như vậy khiến một số khung hình trung
// gian bị "kẹt" lại thành dòng vĩnh viễn thay vì được ghi đè bình thường ->
// gây hiện tượng spam/trùng lặp dòng "Đang quét" y hệt như đã gặp.
//
// Cách sửa: (1) chỉ giữ ĐÚNG 1 dòng trạng thái quét (không phải lịch sử 5
// dòng), và (2) chỉ thực sự vẽ lại tối đa 1 lần mỗi SCAN_THROTTLE_MS mili
// giây, bất kể bên trong xử lý được bao nhiêu chunk trong khoảng đó — giảm
// hẳn tần suất ghi ra terminal, gần như loại bỏ khả năng xảy ra hiện tượng
// kẹt khung hình ở trên. Dòng của chunk CUỐI CÙNG luôn được vẽ (force),
// tránh trường hợp màn hình bị "đứng hình" ở giữa chừng khi quét xong.
const SCAN_THROTTLE_MS = 400;
let lastScanRenderTs = 0;

function pushScanLine(text, force = false) {
  const nowTs = Date.now();
  if (!force && nowTs - lastScanRenderTs < SCAN_THROTTLE_MS) return;
  lastScanRenderTs = nowTs;
  setSection('scan', [text]);
}

export async function getLogs(from, to) {
  let allLogs = [];
  let currentStart = from;

  while (currentStart <= to) {
    let currentEnd = Math.min(currentStart + CHUNK_SIZE - 1, to);
    const isLast = currentEnd >= to;

    pushScanLine(
      `[${now()}] 🔍 Đang quét block: ${currentStart} -> ${currentEnd} (Latest: ${to})`,
      isLast
    );

    let success = false;
    let retries = 3;

    while (retries > 0 && !success) {
      try {
        const logs = await rpc("eth_getLogs", [
          {
            address: FACTORIES,
            fromBlock: "0x" + currentStart.toString(16),
            toBlock: "0x" + currentEnd.toString(16),
            topics: [TOPIC_TOKEN_LAUNCHED],
          },
        ]);
        if (Array.isArray(logs)) {
          allLogs.push(...logs);
          success = true;
        }
      } catch (e) {
        retries--;
        if (retries === 0) {
          // Không in thêm dòng lỗi riêng nữa — trạng thái RPC lỗi đã được
          // hiển thị gộp thành 1 dòng duy nhất trong rpcClient.mjs. Bỏ qua
          // chunk này và đi tiếp (chunk tiếp theo có thể qua được nếu RPC
          // vừa hồi phục).
        } else {
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }
    currentStart = currentEnd + 1;
  }
  return allLogs;
}
