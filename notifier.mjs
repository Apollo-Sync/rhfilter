import fs from 'fs';
import { STOCK_QUOTES, settings, BLOCK_TIME_SEC } from './config.mjs';
import { getLiq, getLiqVerified } from './liquidity.mjs';
import { getCurveLiqUsd } from './curveLiquidity.mjs';
import { getOnChainStats, hasTradingActivitySince, getDevAddress, fetchTransferLogs, classifyDevTransfers, getTotalSupply, getBalanceOf } from './onchainStats.mjs';
import { getLaunchSocials } from './launchMeta.mjs';
import { latestBlock } from './rpcClient.mjs';
import { now, fmtPct, decodeTokenLaunched, quoteSymbol, xTickerSearch, xCaSearch } from './format.mjs';
import { setSection, printPermanent } from './screen.mjs';
import { createTelegramNotifier } from './telegram.mjs';

// Bot Telegram của radar.mjs - đọc cấu hình từ telegram.txt (đặt ở gốc
// project). checkLiquidity.mjs dùng 1 bot khác, đọc từ
// telegram-checkliquidity.txt (xem src/telegram.mjs). Export ra để
// radar.mjs dùng chung 1 instance duy nhất (verifyTelegramConnection lúc
// khởi động, hiển thị trạng thái BẬT/TẮT).
export const telegram = createTelegramNotifier('telegram.txt');

// Ghi lại địa chỉ contract (CA) của token bị bỏ qua (rug/hết giao dịch, dev
// chưa xả kịp...) vào ca-rug.txt, và token đạt đủ mọi điều kiện (đã báo)
// vào ca-ok.txt — mỗi CA 1 dòng, luôn ghi nối vào CUỐI file hiện có (không
// ghi đè nội dung cũ). Không ghi gì cho token bị loại do thiếu X, vì đó vẫn
// là im lặng bỏ qua như trước giờ.
//
// Mỗi dòng ghi dạng CSV: token,curve,pairToken (curve/pairToken có thể để
// trống nếu không có). Lưu kèm curve+pairToken (đã có sẵn trong scope lúc
// ghi, từ event TokenLaunched) để sau này checkLiquidity.mjs có thể đọc
// thanh khoản THẬT trực tiếp on-chain (xem curveLiquidity.mjs) khi rà lại
// ca-rug.txt, thay vì chỉ dựa vào GeckoTerminal/DexScreener — 2 nguồn có độ
// trễ cache, có thể trả về số liệu CŨ từ trước khi rug (bug đã gặp: báo
// $5,397 trong khi thực tế chỉ còn $4.84 / tương tự trường hợp checkLiquidity
// báo nhầm hàng loạt token "còn $4k" trong khi GMGN đã về $0.00x).
const CA_OK_FILE = 'ca-ok.txt';
const CA_RUG_FILE = 'ca-rug.txt';

function appendCa(filePath, token, curve = null, pairToken = null) {
  try {
    const row = curve ? `${token},${curve},${pairToken || ''}` : token;
    fs.appendFileSync(filePath, row + "\n", "utf8");
  } catch (e) {
    console.error(`[-] Không ghi được CA vào ${filePath}: ${e.message}`);
  }
}

const seenTx = new Set();
const seenToken = new Set();

const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function printAlert(token, log, launch, meta, info, stats, devDumpPct) {
  const liq = info?.liq || 0;
  const mc = info?.mc || 0;
  const quote = quoteSymbol(launch.pairToken) || info?.quoteSym || null;

  const sym = info?.sym || meta?.symbol || "?";
  const name = info?.name || meta?.name || "";
  const twitter = meta?.twitter || info?.twitter || null;
  const telegram = meta?.telegram || info?.telegram || null;
  const website = meta?.website || info?.website || null;

  const lines = [];
  lines.push(GREEN + "=".repeat(64));
  lines.push(`[${now()}] 🆕 New Listing (GMGN)   $${sym}  ${name}`);
  lines.push(`  CA       ${token}`);
  lines.push(`  Curve    ${launch.curve}`);
  lines.push(`  Deployer ${launch.deployer}`);
  lines.push(`  Tx       ${log.transactionHash}`);
  lines.push(`  Block    ${parseInt(log.blockNumber, 16)}`);
  lines.push(
    info
      ? `  Liq      $${liq.toLocaleString("en-US")}  (${info.source})`
      : "  Liq      chưa index (token còn trên bonding curve)"
  );
  lines.push(`  MC/FDV   $${mc.toLocaleString("en-US")}`);
  lines.push(`  Holders  ${stats?.holders ?? "n/a"}`);
  lines.push(`  Top10    ${fmtPct(stats?.top10)}`);
  lines.push(`  Snipers  ${stats?.snipers ?? "n/a"}`);
  lines.push(`  Dev hold ${fmtPct(stats?.devPct)}`);
  lines.push(`  X        ${twitter || "n/a"}`);
  lines.push(`  Telegram ${telegram || "n/a"}`);
  lines.push(`  Web      ${website || "n/a"}`);
  lines.push(`  GMGN     https://gmgn.ai/robinhood/token/${token}`);
  if (settings.minAliveSec > 0) {
    lines.push(`  Alive    đã sống ≥ ${settings.minAliveSec}s, còn thanh khoản/giao dịch trong ${settings.recentAliveWindowSec}s gần nhất ✅`);
  }
  if (settings.requireDevDumped) {
    const pctStr = devDumpPct != null ? `${devDumpPct.toFixed(2)}%` : "n/a";
    lines.push(`  DevDump  dev từng giữ ≥ ${settings.devMinHoldPct}%, giờ còn ${pctStr} (đã xả ≥ ${100 - settings.devDumpThresholdPct}%), token vẫn sống sau đó ✅`);
  }

  if (quote && STOCK_QUOTES.includes(quote.toUpperCase())) {
    lines.push(`  Pair     ${sym}/${quote}  ⚡ pair với cổ phiếu -> khả năng đang bám tin ${quote}`);
  } else if (quote) {
    lines.push(`  Pair     ${sym}/${quote}`);
  }

  const tSym = xTickerSearch(sym !== "?" ? sym : null);
  const tCa = xCaSearch(token);
  if (tSym) lines.push(`  X ticker ${tSym}`);
  if (tCa) lines.push(`  X CA     ${tCa}`);

  lines.push("=".repeat(64) + RESET);

  printPermanent(lines.join("\n"));
}

// Đếm gộp: số token đang chờ xác nhận còn sống / đang chờ dev xả hàng, và
// số đã bị bỏ qua (rug / dev chưa xả / không có X) trong đợt hiện tại —
// hiển thị chung 1 dòng động (khu vực 'tracking' trong screen.mjs) thay vì
// in một dòng riêng cho mỗi token. Khi hết token đang chờ, dòng được chốt
// lại thành dòng vĩnh viễn và bộ đếm bỏ qua được reset cho đợt kế tiếp.
let watchingCount = 0;
let watchingDevDumpCount = 0;
let rugSkippedCount = 0;
let devSkippedCount = 0;
let noXSkippedCount = 0;

function drawStatusLine() {
  const parts = [];
  if (watchingCount > 0) {
    parts.push(`⏳ đang theo dõi ${watchingCount} token (chờ ${settings.minAliveSec}s)`);
  }
  if (watchingDevDumpCount > 0) {
    parts.push(`🕵️ đang chờ dev xả hàng ${watchingDevDumpCount} token`);
  }
  if (rugSkippedCount > 0) {
    parts.push(`💀 đã bỏ qua ${rugSkippedCount} (rug/hết giao dịch)`);
  }
  if (devSkippedCount > 0) {
    parts.push(`🐋 đã bỏ qua ${devSkippedCount} (dev chưa xả hết/hết giờ chờ)`);
  }
  if (noXSkippedCount > 0) {
    parts.push(`⏭ đã bỏ qua ${noXSkippedCount} (không có X)`);
  }

  const stillActive = watchingCount > 0 || watchingDevDumpCount > 0;

  if (parts.length === 0) {
    setSection('tracking', []);
    return;
  }

  const text = `[${now()}] ${parts.join("  —  ")}`;
  setSection('tracking', [`${DIM}${text}${RESET}`]);

  if (!stillActive) {
    // Không còn token nào đang chờ ở bất kỳ giai đoạn nào -> xoá dòng động
    // và reset bộ đếm bỏ qua để đợt kiểm tra tiếp theo bắt đầu từ 0.
    setSection('tracking', []);
    rugSkippedCount = 0;
    devSkippedCount = 0;
    noXSkippedCount = 0;
  }
}

// Giới hạn tần suất vẽ dòng trạng thái: khi có nhiều token launch dồn dập
// (Robinhood Chain block time ~100ms), watchingCount/watchingDevDumpCount có
// thể đổi hàng chục-hàng trăm lần/giây, khiến drawStatusLine() bị gọi liên
// tục và tràn log (mỗi lần ghi \r không kịp đè lên dòng cũ hoặc môi trường
// log không phải TTY thật sự). Gom mọi lần gọi dồn dập trong khoảng
// STATUS_THROTTLE_MS lại thành tối đa 1 lần vẽ thực sự.
const STATUS_THROTTLE_MS = 1000;
let lastDrawTime = 0;
let trailingTimer = null;

function renderStatusLine() {
  const elapsed = Date.now() - lastDrawTime;
  if (elapsed >= STATUS_THROTTLE_MS) {
    lastDrawTime = Date.now();
    drawStatusLine();
  } else if (!trailingTimer) {
    trailingTimer = setTimeout(() => {
      trailingTimer = null;
      lastDrawTime = Date.now();
      drawStatusLine();
    }, STATUS_THROTTLE_MS - elapsed);
  }
  // Nếu đã có 1 lần vẽ đang chờ (trailingTimer), bỏ qua lời gọi này —
  // lần vẽ đó sẽ tự đọc state mới nhất khi tới lượt chạy.
}

// Kiểm tra nhanh 1 lần: token còn thanh khoản THẬT (≥ ngưỡng minAliveLiqUsd,
// không chỉ đơn giản là > 0 — vì LP đã bị rút gần sạch vẫn có thể còn dính
// lại vài phần nghìn đô do làm tròn/cache của Gecko/DexScreener) HOẶC vẫn
// còn giao dịch (Transfer) từ ví KHÁC ví deployer sau block launch.
//
// deployer: nếu có, sẽ bị loại khỏi phần đếm Transfer — tránh trường hợp
// chính giao dịch dev xả hàng (Transfer từ ví dev) bị tính nhầm là "vẫn còn
// giao dịch", trong khi thực tế dev bán xong là token im re, không ai mua
// bán gì thêm.
async function quickAliveCheck(token, launchBlockNum, deployer = null, curve = null, pairToken = null) {
  // 1. Thanh khoản: nếu bạn đặt ngưỡng (minAliveLiqUsd > 0), đây là điều
  //    kiện BẮT BUỘC (VÀ). Ưu tiên đọc THẲNG on-chain từ ví Curve (số dư
  //    ETH/quote-asset thật đang nằm trong curve — xem curveLiquidity.mjs),
  //    vì GeckoTerminal/DexScreener có độ trễ index, từng gây báo sai
  //    ($5,397 trong khi thực tế chỉ còn $4.84 vì bot đọc phải số liệu cache
  //    cũ ngay lúc thanh khoản đang bị rút rất nhanh). Chỉ fallback sang API
  //    ngoài (có double-check) khi không đọc on-chain được (quote là cổ
  //    phiếu tokenized hoá, hoặc token đã graduate sang pool khác).
  if (settings.minAliveLiqUsd > 0) {
    let liqInfo = null;
    try {
      liqInfo = await getCurveLiqUsd(curve, pairToken);
    } catch {}
    if (!liqInfo) {
      try {
        liqInfo = await getLiqVerified(token, 3);
      } catch {}
    }
    if (!liqInfo || liqInfo.liq < settings.minAliveLiqUsd) return false;
  }

  // 2. Dù thanh khoản đã đạt, vẫn cần có giao dịch GẦN ĐÂY để chắc chắn
  // token không phải "đứng hình" dù thanh khoản còn dính lại. Chỉ tính
  // Transfer trong recentAliveWindowSec giây GẦN NHẤT, không quét từ
  // launchBlockNum tới giờ — nếu quét từ lúc launch, chỉ cần có sniper mua
  // ngay sau khi launch là token sẽ mãi mãi bị coi là "còn giao dịch" dù
  // thực tế đã im re từ lâu.
  try {
    const current = await latestBlock();
    const windowBlocks = Math.max(1, Math.ceil(settings.recentAliveWindowSec / BLOCK_TIME_SEC));
    const from = Math.max(launchBlockNum + 1, current - windowBlocks);
    return await hasTradingActivitySince(token, from, current, deployer);
  } catch {
    return false;
  }
}

// Chờ minAliveSec giây rồi kiểm tra token còn "sống" hay không:
// còn thanh khoản thật (≥ ngưỡng) HOẶC vẫn còn giao dịch mới (không tính
// giao dịch của deployer) sau block launch.
// Trả về true nếu còn sống, false nếu coi như đã rug/hết vol.
async function checkStillAlive(token, launchBlockNum, minAliveSec, deployer, curve, pairToken) {
  watchingCount++;
  renderStatusLine();

  try {
    await new Promise((r) => setTimeout(r, minAliveSec * 1000));
    const alive = await quickAliveCheck(token, launchBlockNum, deployer, curve, pairToken);
    if (!alive) rugSkippedCount++;
    return alive;
  } finally {
    watchingCount--;
    renderStatusLine();
  }
}

// Chờ đến khi dev/deployer thực sự "DS" (bán thẳng token vào ví curve —
// giống cách GMGN gắn nhãn DS) VÀ % tổng cung dev còn giữ đã về gần 0, VÀ
// ngay sau đó token vẫn còn thanh khoản/giao dịch (nến vẫn chạy). Chỉ dựa
// vào % số dư giảm KHÔNG đủ tin cậy — dev có thể chuyển token sang ví khác
// (không phải bán thật, giá không bị ảnh hưởng). Nên bắt buộc phải thấy
// đúng 1 giao dịch Transfer từ ví dev THẲNG vào ví curve (DS thật) trước
// khi coi là đã xả. Quét theo kiểu tích luỹ (chỉ quét thêm block mới mỗi
// lần poll) để đỡ tốn RPC hơn quét lại từ đầu mỗi lần.
async function waitForDevDump(token, deployer, launchBlockNum, curve, pairToken) {
  watchingDevDumpCount++;
  renderStatusLine();

  try {
    const { devDumpThresholdPct, devDumpMaxWaitSec, devDumpPollSec } = settings;
    const deadline = Date.now() + devDumpMaxWaitSec * 1000;

    let scannedUpTo = launchBlockNum;
    let sellCount = 0;

    while (Date.now() < deadline) {
      let devPct = null;
      try {
        const current = await latestBlock();
        if (current > scannedUpTo) {
          const logs = await fetchTransferLogs(token, scannedUpTo + 1, current);
          const { sells } = classifyDevTransfers(logs, deployer, curve);
          sellCount += sells.length;
          scannedUpTo = current;
        }
        const [totalSupply, devBal] = await Promise.all([
          getTotalSupply(token),
          getBalanceOf(token, deployer),
        ]);
        devPct = totalSupply > 0n ? Number((devBal * 100000n) / totalSupply) / 1000 : null;
      } catch {}

      // Chỉ coi là "đã xả" (DS thật) khi: (1) có ít nhất 1 giao dịch bán
      // thẳng vào curve, VÀ (2) hiện tại đã tụt xuống ≤ ngưỡng.
      const dumped = sellCount > 0 && devPct != null && devPct <= devDumpThresholdPct;

      if (dumped) {
        const stillAlive = await quickAliveCheck(token, launchBlockNum, deployer, curve, pairToken);
        return { ok: stillAlive, devPct };
      }

      await new Promise((r) => setTimeout(r, devDumpPollSec * 1000));
    }

    return { ok: false, devPct: null }; // hết giờ chờ mà vẫn chưa thấy DS thật + về 0%
  } finally {
    watchingDevDumpCount--;
    renderStatusLine();
  }
}

export async function onNewToken(log) {
  const launch = decodeTokenLaunched(log);
  const token = launch.token;
  if (!token) return;

  const key = `${log.transactionHash}:${log.logIndex}`;
  if (seenTx.has(key) || seenToken.has(token)) return;
  seenTx.add(key);
  seenToken.add(token);

  const launchBlockNum = parseInt(log.blockNumber, 16);

  // Bộ lọc X (Twitter): kiểm tra ĐẦU TIÊN, trước mọi bộ lọc khác. Social
  // (X/Telegram/Web) nằm sẵn trong calldata của tx launch nên chỉ cần 1 lần
  // gọi RPC đọc transaction — không cần chờ gì cả. Nếu bật requireTwitter mà
  // token không có X thì loại token luôn tại đây, không tốn request chờ
  // minAliveSec (có thể vài trăm giây) hay chờ dev xả hàng cho một token
  // chắc chắn sẽ bị loại ở bước cuối cùng.
  const meta = await getLaunchSocials(log.transactionHash);
  if (settings.requireTwitter) {
    let hasTwitter = Boolean(meta?.twitter);

    // Dev không phải lúc nào cũng điền X ngay trong calldata launch — đôi
    // khi X chỉ được index sau bởi GeckoTerminal/DexScreener (lấy từ
    // website/description...). Trước khi loại hẳn, thử thêm 1 lần nhẹ
    // (không lặp lại như getLiq mặc định) để không bỏ sót oan các token đó,
    // mà vẫn không phải chờ hàng trăm giây như bộ lọc "sống tối thiểu".
    if (!hasTwitter) {
      try {
        const quickInfo = await getLiq(token, 1);
        if (quickInfo?.twitter) hasTwitter = true;
      } catch {}
    }

    if (!hasTwitter) {
      noXSkippedCount++;
      renderStatusLine();
      return;
    }
  }

  // Bộ lọc: token phải sống tối thiểu N giây (còn thanh khoản/giao dịch)
  // trước khi được báo. Lọc bớt token bị dev rug ngay sau vài giây.
  const minAliveSec = settings.minAliveSec;
  if (minAliveSec > 0) {
    const alive = await checkStillAlive(token, launchBlockNum, minAliveSec, launch.deployer, launch.curve, launch.pairToken);
    if (!alive) {
      // Đã cộng dồn vào bộ đếm "đã bỏ qua" trong checkStillAlive, không in
      // riêng từng dòng nữa để tránh spam.
      appendCa(CA_RUG_FILE, token, launch.curve, launch.pairToken);
      return;
    }
  }

  // Bộ lọc bổ sung: chỉ báo khi dev/deployer đã xả (gần) hết hàng VÀ token
  // vẫn còn sống ngay sau đó — tránh trường hợp token "trông" còn sống
  // nhưng dev vẫn ôm hàng, có thể rug bất cứ lúc nào.
  let devDumpPct = null;
  if (settings.requireDevDumped) {
    // launch.deployer (decode từ event) đôi khi chỉ là router/relayer, nên
    // tra ví dev thật qua Blockscout trước; fallback về launch.deployer nếu
    // Blockscout lỗi/không tra được.
    let devAddr = null;
    try {
      devAddr = await getDevAddress(token);
    } catch {}
    if (!devAddr) devAddr = launch.deployer;

    const devResult = await waitForDevDump(token, devAddr, launchBlockNum, launch.curve, launch.pairToken);
    if (!devResult.ok) {
      devSkippedCount++;
      renderStatusLine();
      appendCa(CA_RUG_FILE, token, launch.curve, launch.pairToken);
      return;
    }
    devDumpPct = devResult.devPct;
  }

  // Lấy liquidity/holders (đã có meta/social từ bước lọc X ở trên). Vẫn cần
  // gọi API ngoài để có name/symbol/social đầy đủ cho box alert, nhưng số
  // "Liq" hiển thị sẽ được GHI ĐÈ bằng số đọc trực tiếp on-chain từ ví Curve
  // nếu đọc được — chính xác/real-time hơn hẳn API ngoài (xem
  // curveLiquidity.mjs), tránh trường hợp hiển thị số liệu cache cũ như bug
  // đã gặp ($5,397 hiển thị trong khi thực tế đã tụt còn $4.84).
  const [apiInfo, stats] = await Promise.all([
    settings.minAliveLiqUsd > 0 ? getLiqVerified(token) : getLiq(token),
    getOnChainStats(token, log.blockNumber)
  ]);

  let info = apiInfo;
  try {
    const onchainLiq = await getCurveLiqUsd(launch.curve, launch.pairToken);
    if (onchainLiq) {
      info = { ...(apiInfo || {}), liq: onchainLiq.liq, source: onchainLiq.source };
    }
  } catch {}

  printAlert(token, log, launch, meta, info, stats, devDumpPct);
  appendCa(CA_OK_FILE, token, launch.curve, launch.pairToken);

  // Bắn kèm thông báo Telegram (song song với việc in log ở trên). Không
  // await/chặn luồng chính - lỗi mạng/API Telegram chỉ log ra console, tự
  // catch bên trong sendTelegramMessage(), không làm crash radar.
  if (telegram.telegramEnabled) {
    const text = telegram.buildTelegramAlert({
      token, log, launch, meta, info, stats, devDumpPct,
      settings, fmtPct, quoteSymbol, STOCK_QUOTES, now,
    });
    telegram.sendTelegramMessage(text).catch(() => {});
  }
}
