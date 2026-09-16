import fs from 'fs';
import path from 'path';
import readline from 'readline';

// Đọc danh sách RPC từ file — TỰ CHỌN file mặc định theo tên script đang
// chạy, để radar.mjs và checkLiquidity.mjs không cần gõ thêm gì vẫn tự dùng
// 2 nhóm RPC khác nhau (đỡ nghẽn khi chạy đồng thời — xem giải thích ở
// rpcClient.mjs):
//   node radar.mjs           -> mặc định rpc.txt
//   node checkLiquidity.mjs  -> mặc định rpc2.txt
//   node scanDevSold.mjs     -> mặc định rpc.txt (dùng chung với radar.mjs)
// Vẫn có thể ép dùng file khác qua biến môi trường RPC_FILE, ví dụ:
//   RPC_FILE=rpc.txt node checkLiquidity.mjs
const entryFile = process.argv[1] ? path.basename(process.argv[1]) : '';
const DEFAULT_RPC_FILE = entryFile === 'checkLiquidity.mjs' ? 'rpc2.txt' : 'rpc.txt';
export const RPC_FILE_NAME = process.env.RPC_FILE || DEFAULT_RPC_FILE;

function loadRpcList() {
  try {
    const data = fs.readFileSync(RPC_FILE_NAME, 'utf8');
    const list = data
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
    if (list.length > 0) return list;
  } catch (e) {
    console.log(`[-] Không tìm thấy file ${RPC_FILE_NAME} hoặc file trống, dùng RPC mặc định.`);
  }
  return ["https://rpc.mainnet.chain.robinhood.com"];
}

export const RPC_LIST = loadRpcList();

export const POLL_SEC = 6;
export const LOOKBACK_BLOCKS = 400;   // Dải quét lịch sử rộng khi khởi động
export const CHUNK_SIZE = 5;          // Chia nhỏ dải block để tương thích với giới hạn của RPC Free

// Thời gian trung bình mỗi block trên Robinhood Chain (ước lượng ~100ms).
// Dùng để quy đổi "N giây gần nhất" sang số block cần quét khi kiểm tra
// giao dịch gần đây (xem recentAliveWindowSec bên dưới).
export const BLOCK_TIME_SEC = 0.1;

// ─── Bộ lọc: token phải "sống" tối thiểu N giây trước khi được bắn alert ──
// "Sống" = sau N giây kể từ lúc phát hiện, token vẫn còn thanh khoản
// (chưa bị rút LP) hoặc vẫn còn phát sinh giao dịch (Transfer) mới.
// requireTwitter: chỉ báo token có link X (Twitter).
// requireDevDumped: chỉ báo token khi dev/deployer đã xả (gần) hết hàng
// (số dư ví dev < devDumpThresholdPct% tổng cung) VÀ ngay sau đó token vẫn
// còn thanh khoản/giao dịch (nến vẫn chạy) — tránh trường hợp dev chưa xả
// xong, có thể rug bất cứ lúc nào dù token "trông" như còn sống.
// Tất cả được nhập tay ở terminal lúc khởi động.
// Có thể set sẵn qua biến môi trường để bỏ qua bước hỏi:
//   MIN_ALIVE_SEC, REQUIRE_X, REQUIRE_DEV_DUMP, DEV_DUMP_THRESHOLD_PCT, DEV_DUMP_MAX_WAIT_MIN
export const settings = {
  minAliveSec: 0,
  requireTwitter: false,
  requireDevDumped: false,
  devDumpThresholdPct: 2,     // dev còn giữ dưới X% tổng cung -> coi như đã xả hết
  // Dev phải từng nắm giữ ÍT NHẤT X% tổng cung tại một thời điểm nào đó
  // trước khi bị coi là "đã xả". Bắt buộc phải có điều kiện này, nếu không
  // token mà dev CHƯA TỪNG MUA (balance = 0% ngay từ đầu vì lúc launch token
  // chưa mint vào ví dev, dev phải tự mua qua curve như người khác) sẽ bị
  // tính NHẦM là "đã xả hết" ngay lập tức (0% <= threshold), trong khi thực
  // tế dev mua SAU ĐÓ và vẫn đang ôm hàng. Có thể override qua biến môi
  // trường DEV_MIN_HOLD_PCT.
  // (Không còn được dùng trực tiếp bởi waitForDevDump nữa — từ khi đổi
  // sang bắt đúng giao dịch DS thật (Transfer dev -> curve) thay vì chỉ
  // nhìn % số dư giảm, trường hợp "dev chưa từng mua" tự động bị loại vì
  // không có giao dịch DS nào để bắt. Giữ lại setting này để không phá vỡ
  // luồng hỏi cấu hình / phòng khi cần dùng lại logic cũ.
  devMinHoldPct: 3,
  devDumpMaxWaitSec: 600,     // chờ tối đa (giây) để xác nhận dev xả hàng trước khi bỏ qua
  devDumpPollSec: 10,         // tần suất kiểm tra lại số dư dev (giây)
  // Thanh khoản tối thiểu (USD) để coi là "còn sống". Trước đây chỉ cần
  // liq > 0 là tính alive, nên token đã bị rút gần sạch LP (còn dính lại
  // vài phần nghìn đô do làm tròn/cache) vẫn bị tính nhầm là còn sống.
  // Có thể override qua biến môi trường MIN_ALIVE_LIQ_USD.
  minAliveLiqUsd: 20,
  // Khi kiểm tra "còn giao dịch không", CHỈ tính các Transfer xảy ra trong
  // N giây gần nhất (tính đến thời điểm check), KHÔNG tính từ lúc launch
  // tới giờ. Nếu tính từ lúc launch, chỉ cần có sniper mua ngay sau launch
  // là token sẽ MÃI MÃI được coi là "còn sống" dù sau đó không ai giao
  // dịch gì thêm (đây chính là lỗi: nến trên GMGN đã đứng im nhưng bot vẫn
  // báo Alive). Có thể override qua biến môi trường RECENT_ALIVE_WINDOW_SEC.
  recentAliveWindowSec: 30,
};

function askQuestion(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

// Hỏi người dùng các bộ lọc lúc khởi động: số giây tối thiểu token phải
// sống, có yêu cầu link X hay không, và có yêu cầu dev phải xả (gần) hết
// hàng (mà token vẫn còn sống) hay không. Nếu đã set biến môi trường tương
// ứng thì dùng luôn, không hỏi lại.
export async function promptSettings() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const envMinLiq = parseFloat(process.env.MIN_ALIVE_LIQ_USD);
  if (Number.isFinite(envMinLiq) && envMinLiq >= 0) {
    settings.minAliveLiqUsd = envMinLiq;
    console.log(`[*] MIN_ALIVE_LIQ_USD=$${envMinLiq} (lấy từ biến môi trường).`);
  } else {
    const answerLiq = await askQuestion(
      rl,
      `[?] Thanh khoản tối thiểu (USD) để coi token là "còn sống"? (Enter = $${settings.minAliveLiqUsd}): `
    );
    const liq = parseFloat(String(answerLiq).trim());
    if (Number.isFinite(liq) && liq >= 0) settings.minAliveLiqUsd = liq;
  }
  console.log(`[+] Ngưỡng thanh khoản tối thiểu: $${settings.minAliveLiqUsd}.`);

  const envRecentWindow = parseInt(process.env.RECENT_ALIVE_WINDOW_SEC, 10);
  if (Number.isFinite(envRecentWindow) && envRecentWindow > 0) {
    settings.recentAliveWindowSec = envRecentWindow;
    console.log(`[*] RECENT_ALIVE_WINDOW_SEC=${envRecentWindow}s (lấy từ biến môi trường).`);
  } else {
    const answerWindow = await askQuestion(
      rl,
      `[?] Chỉ tính là "còn giao dịch" nếu có Transfer trong bao nhiêu giây gần nhất? (Enter = ${settings.recentAliveWindowSec}s): `
    );
    const win = parseInt(String(answerWindow).trim(), 10);
    if (Number.isFinite(win) && win > 0) settings.recentAliveWindowSec = win;
  }
  console.log(`[+] Cửa sổ kiểm tra giao dịch gần nhất: ${settings.recentAliveWindowSec}s.`);
  console.log("");

  const envAlive = parseInt(process.env.MIN_ALIVE_SEC, 10);
  if (Number.isFinite(envAlive) && envAlive >= 0) {
    settings.minAliveSec = envAlive;
    console.log(`[*] MIN_ALIVE_SEC=${envAlive}s (lấy từ biến môi trường).`);
  } else {
    const answer = await askQuestion(
      rl,
      '[?] Token phải "sống" (còn thanh khoản/giao dịch) tối thiểu bao nhiêu giây trước khi báo? (Enter = 0, tắt bộ lọc): '
    );
    const sec = parseInt(String(answer).trim(), 10);
    settings.minAliveSec = Number.isFinite(sec) && sec > 0 ? sec : 0;
  }

  if (settings.minAliveSec > 0) {
    console.log(`[+] Đã bật bộ lọc: chỉ báo token sống tối thiểu ${settings.minAliveSec}s.`);
  } else {
    console.log(`[+] Bộ lọc "sống tối thiểu" đang TẮT (báo ngay khi phát hiện).`);
  }

  const envTwitter = process.env.REQUIRE_X;
  if (envTwitter === "1" || envTwitter === "true") {
    settings.requireTwitter = true;
    console.log(`[*] REQUIRE_X=1 (lấy từ biến môi trường).`);
  } else if (envTwitter === "0" || envTwitter === "false") {
    settings.requireTwitter = false;
  } else {
    const answerX = await askQuestion(
      rl,
      '[?] Chỉ báo token có link X (Twitter)? (y/N): '
    );
    const norm = String(answerX).trim().toLowerCase();
    settings.requireTwitter = norm === "y" || norm === "yes";
  }

  console.log(
    settings.requireTwitter
      ? `[+] Đã bật bộ lọc: chỉ báo token có link X.`
      : `[+] Bộ lọc "yêu cầu link X" đang TẮT (báo cả token không có X).`
  );

  const envDevDump = process.env.REQUIRE_DEV_DUMP;
  if (envDevDump === "1" || envDevDump === "true") {
    settings.requireDevDumped = true;
    console.log(`[*] REQUIRE_DEV_DUMP=1 (lấy từ biến môi trường).`);
  } else if (envDevDump === "0" || envDevDump === "false") {
    settings.requireDevDumped = false;
  } else {
    const answerDump = await askQuestion(
      rl,
      '[?] Chỉ báo token khi dev đã xả (gần) hết hàng VÀ token vẫn còn sống sau đó? (y/N): '
    );
    const norm = String(answerDump).trim().toLowerCase();
    settings.requireDevDumped = norm === "y" || norm === "yes";
  }

  if (settings.requireDevDumped) {
    const envMinHold = parseFloat(process.env.DEV_MIN_HOLD_PCT);
    if (Number.isFinite(envMinHold) && envMinHold >= 0) {
      settings.devMinHoldPct = envMinHold;
      console.log(`[*] DEV_MIN_HOLD_PCT=${envMinHold}% (lấy từ biến môi trường).`);
    }

    const envPct = parseFloat(process.env.DEV_DUMP_THRESHOLD_PCT);
    if (Number.isFinite(envPct) && envPct >= 0) {
      settings.devDumpThresholdPct = envPct;
    } else {
      const answerPct = await askQuestion(
        rl,
        `[?] Coi là "đã xả hết" khi dev còn giữ dưới bao nhiêu % tổng cung? (Enter = ${settings.devDumpThresholdPct}%): `
      );
      const pct = parseFloat(String(answerPct).trim());
      if (Number.isFinite(pct) && pct >= 0) settings.devDumpThresholdPct = pct;
    }

    const envMaxWaitMin = parseFloat(process.env.DEV_DUMP_MAX_WAIT_MIN);
    if (Number.isFinite(envMaxWaitMin) && envMaxWaitMin >= 0) {
      settings.devDumpMaxWaitSec = Math.round(envMaxWaitMin * 60);
    } else {
      const defaultMin = Math.round(settings.devDumpMaxWaitSec / 60);
      const answerWait = await askQuestion(
        rl,
        `[?] Chờ tối đa bao nhiêu phút để xác nhận dev xả hàng trước khi bỏ qua? (Enter = ${defaultMin} phút): `
      );
      const min = parseFloat(String(answerWait).trim());
      if (Number.isFinite(min) && min >= 0) settings.devDumpMaxWaitSec = Math.round(min * 60);
    }

    console.log(
      `[+] Đã bật bộ lọc: chỉ báo khi dev còn giữ < ${settings.devDumpThresholdPct}% tổng cung ` +
      `và token vẫn còn sống (chờ tối đa ${Math.round(settings.devDumpMaxWaitSec / 60)} phút).`
    );
  } else {
    console.log(`[+] Bộ lọc "chờ dev xả hàng" đang TẮT.`);
  }

  console.log("");
  rl.close();
  return settings;
}

// Blockscout API (Robinhood Chain) — dùng để tra ra ví dev THẬT (EOA đã gọi
// tạo token), vì address indexed "deployer" trong event TokenLaunched đôi
// khi chỉ là router/relayer chứ không phải ví dev trực tiếp. Xem
// getDevAddress() trong onchainStats.mjs.
export const BLOCKSCOUT_API = "https://robinhoodchain.blockscout.com/api/v2";

// Pons V2 Launch Factory trên Robinhood Chain — nơi phát sinh mọi token mới
export const FACTORIES = [
  "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e",
];

// Không còn cần theo dõi executor (dùng cho graduate/migrate) nữa.
export const EXECUTOR = "0xc7819b64a1daecd7ec19856d026cb14efbd89046";

// Chỉ bắt sự kiện TokenLaunched — bắn ngay tại thời điểm token được tạo/list,
// không cần đợi graduate/migrate (LaunchSwept / PoolGraduated) nữa.
export const TOPIC_TOKEN_LAUNCHED =
  "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607";

export const TOPICS = [TOPIC_TOKEN_LAUNCHED];

// ─── Bộ lọc: chỉ log token có thông tin X (Twitter) ───────────────────────
// Được hỏi trực tiếp ở terminal lúc khởi động (xem promptSettings ở trên),
// giá trị nằm trong settings.requireTwitter. Vẫn có thể set sẵn qua biến môi
// trường REQUIRE_X=1 (hoặc REQUIRE_X=0) để bỏ qua câu hỏi.

export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// Các quote token là cổ phiếu tokenized trên RH chain — nếu token pair với
// một trong số này, khả năng cao nó đang bám câu chuyện của cổ phiếu đó.
export const STOCK_QUOTES = [
  "NVDA", "AAPL", "HOOD", "SPY", "TSLA", "MSTR",
  "GOOGL", "AMZN", "META", "NFLX", "COIN", "QQQ",
];

// Map địa chỉ pairToken -> ký hiệu, để hiển thị ngay lúc log mà không cần
// chờ liquidity index (GeckoTerminal/DexScreener thường chưa có dữ liệu
// cho token vừa launch, còn đang nằm trên bonding curve).
export const QUOTE_TOKENS = {
  "0x0000000000000000000000000000000000000000": "ETH",
  "0x5fc5360d0400a0fd4f2af552add042d716f1d168": "USDG",
  "0xcec185eb182c47d1ba1efc84e6959e18cd620be4": "cbBTC",
  "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9": "AAPL",
  "0x86923f96303d656e4aa86d9d42d1e57ad2023fdc": "AMD",
  "0x12f190a9f9d7d37a250758b26824b97ce941bf54": "AMZN",
  "0x48e39e56acdba37b09020c0b734a613c9a2f100a": "BB",
  "0x6330d8c3178a418788df01a47479c0ce7ccf450b": "COIN",
  "0x4ea005168d7f09a7a0ba9d1def21a479950e44c2": "COST",
  "0xdf0992e440dd0be65bd8439b609d6d4366bf1cb5": "CRCL",
  "0x941ae714ec6d8130c7b75d67160ca08f1e7d11dd": "DELL",
  "0x1d11f0496982706c5e14a514d4e79f2e6bde4516": "DJT",
  "0xc9a981fee1f9dec688bb123ccdecc63d0debfc4e": "GLD",
  "0x1b0e319c6a659f002271b69db8a7df2f911c153e": "GME",
  "0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3": "GOOGL",
  "0xccee82fe024c36fa15e1005ede3e9e4787e23d09": "HIMS",
  "0x8005d266423c7ea827372c9c864491e5786600ea": "LLY",
  "0xc0d6457c16cc70d6790dd43521c899c87ce02f35": "META",
  "0xe93237c50d904957cf27e7b1133b510c669c2e74": "MSFT",
  "0xec262a75e413fafd0df80480274532c79d42da09": "MSTR",
  "0xff080c8ce2e5feadaca0da81314ae59d232d4afd": "MU",
  "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec": "NVDA",
  "0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a": "PLTR",
  "0xd5f3879160bc7c32ebb4dc785f8a4f505888de68": "QQQ",
  "0xf0c4bf4c582cb3836e98394b1d4e7b7281101be8": "RBLX",
  "0x05b37fb53a299a1b874a619e1c4c404d52c36f4c": "RDDT",
  "0x84cab63bc87912e71ad199ff14a0ba45de68fef8": "SKHY",
  "0xb90a19ff0af67f7779aff50a882a9cff42446400": "SNDK",
  "0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea": "SPCX",
  "0x117cc2133c37b721f49de2a7a74833232b3b4c0c": "SPY",
  "0x322f0929c4625ed5bad873c95208d54e1c003b2d": "TSLA",
  "0x58ffe4a942d3885baa22d7520691f611ef09e7aa": "TSM",
  "0x5e81213613b6b86eab4c6c50d718d34359459786": "TTWO",
  "0xa30fa36db767ad9ed3f7a60fc79526fb4d56d344": "USO",
  "0x9e7abd3c9139d14e4c86dce0e455aab7a0c2fb3e": "WYFI",
};
