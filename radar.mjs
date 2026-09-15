import { latestBlock, initRpc } from './src/rpcClient.mjs';
import { getLogs } from './src/logs.mjs';
import { onNewToken } from './src/notifier.mjs';
import { LOOKBACK_BLOCKS, POLL_SEC, settings, promptSettings } from './src/config.mjs';
import { printPermanent } from './src/screen.mjs';
import { telegramEnabled, verifyTelegramConnection } from './src/telegram.mjs';

let fromBlock = null;

export async function tick() {
  try {
    const latest = await latestBlock();
    if (fromBlock == null) {
      fromBlock = Math.max(0, latest - LOOKBACK_BLOCKS);
    }
    
    if (latest - fromBlock > 2000) {
      fromBlock = latest - 2000;
    }

    const toBlock = latest;
    if (fromBlock <= toBlock) {
      const logs = await getLogs(fromBlock, toBlock);

      for (const log of logs) {
        onNewToken(log).catch(e => {});
      }
      
      fromBlock = toBlock + 1;
    }
  } catch (e) {
    // Nếu là lỗi "tất cả RPC đều lỗi" thì đã được thể hiện qua dòng trạng
    // thái RPC (đỏ/xanh) ở rpcClient.mjs rồi — không in thêm dòng trùng lặp
    // ở đây nữa. Các lỗi khác (không liên quan RPC) vẫn log bình thường.
    if (!String(e.message).startsWith("Tất cả RPC trong rpc.txt đều lỗi")) {
      printPermanent(`[!] Lỗi trong vòng lặp tick: ${e.message}`);
    }
  }

  setTimeout(tick, (POLL_SEC || 6) * 1000);
}

async function main() {
  await promptSettings();

  const ok = await initRpc();
  if (!ok) {
    console.log("[-] Không tìm thấy RPC nào khả dụng. Vui lòng kiểm tra lại file rpc.txt!");
    process.exit(1);
  }

  await verifyTelegramConnection();

  const filterMsg = settings.minAliveSec > 0
    ? `chỉ báo token sống ≥ ${settings.minAliveSec}s`
    : `báo ngay khi phát hiện (bộ lọc sống tắt)`;
  const twitterMsg = settings.requireTwitter
    ? `chỉ báo token có X`
    : `không yêu cầu X`;
  const devDumpMsg = settings.requireDevDumped
    ? `chờ dev xả < ${settings.devDumpThresholdPct}% (tối đa ${Math.round(settings.devDumpMaxWaitSec / 60)}p)`
    : `không yêu cầu dev xả hàng`;
  const telegramMsg = telegramEnabled ? `Telegram: BẬT ✅` : `Telegram: TẮT (chưa có telegram.txt hợp lệ)`;
  console.log(`[+] Khởi động Radar thành công (${filterMsg}, ${twitterMsg}, ${devDumpMsg}, ${telegramMsg}). Đang quét token mới (không đợi migrate)...\n`);
  tick();
}

main();
