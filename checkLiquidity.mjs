// checkLiquidity.mjs
//
// Check thanh khoản HIỆN TẠI (tại thời điểm chạy lệnh) cho một danh sách
// lớn CA (contract address), đọc từ file (mặc định ca-rug.txt — danh sách
// token đã bị bot đánh dấu "rug/hết giao dịch" trước đây). Dùng để rà lại
// xem có token nào từng bị bỏ qua nhưng giờ bất ngờ có thanh khoản trở lại
// hay không.
//
// Script này tự gọi thẳng API GeckoTerminal/DexScreener (không dùng lại
// getLiq()/getLiqVerified() trong src/liquidity.mjs) để bạn tự cân chỉnh
// --tries/--concurrency riêng cho việc quét số lượng lớn CA. Có lấy kèm
// social link (X/Telegram/Website) khi tìm thấy token.
//
// ĐỌC ON-CHAIN TRƯỚC (real-time, không cache) khi có thể: notifier.mjs giờ
// ghi kèm curve+pairToken vào ca-rug.txt (dạng "token,curve,pairToken" thay
// vì chỉ "token"), nên với các dòng mới, script đọc thẳng số dư ví Curve qua
// RPC (xem src/curveLiquidity.mjs) — chính xác 100% tại thời điểm chạy, bỏ
// qua hẳn API ngoài cho các dòng này. Chỉ fallback về GeckoTerminal/
// DexScreener khi: dòng cũ không có curve (file ghi từ trước khi sửa), hoặc
// getCurveLiqUsd trả về null (quote asset là cổ phiếu tokenized chưa quy đổi
// được USD ở đây).
//
// LÝ DO CẦN FIX NÀY: GeckoTerminal/DexScreener index có độ trễ cache, có thể
// vẫn trả về số liệu liquidity TỪ TRƯỚC lúc rug trong nhiều phút, dù thực tế
// GMGN đã tụt về gần $0. Trước đây (chỉ dùng API ngoài) đã gây ra đúng bug
// này: 1 loạt token báo "còn ~$4k" trong khi GMGN chỉ còn $0.00x. Token vẫn
// còn trên bonding curve mà API ngoài chưa index kịp -> vẫn có thể ra "n/a"
// (không đổi so với trước), nhưng giờ với dòng có curve thì không còn phụ
// thuộc API ngoài cho trường hợp đó nữa.
//
// Cách chạy:
//   node checkLiquidity.mjs
//   → Chương trình sẽ HỎI TRỰC TIẾP trên terminal: liquidity tối thiểu (lọc
//     từ mốc này trở lên), concurrency, và chế độ chạy:
//       1) Quét 1 lần rồi dừng
//       2) Quét lặp lại mỗi 10 phút — mỗi vòng LUÔN đọc lại nội dung mới
//          nhất từ file CA (ví dụ ca-rug.txt vừa được radar.mjs ghi thêm CA
//          mới trong lúc script đang chạy thì vòng quét kế tiếp sẽ tự thấy).
//     Nhập tay rồi Enter (để trống = lấy mặc định). Không cần nhớ cú pháp --flag.
//
//   Vẫn có thể truyền sẵn qua CLI để bỏ qua câu hỏi tương ứng, ví dụ:
//   node checkLiquidity.mjs --min-liq 10000                        (bỏ qua câu min-liq)
//   node checkLiquidity.mjs --min-liq 10000 --concurrency 20 --mode 2  (bỏ qua cả 3 câu hỏi, chạy lặp luôn)
//
// Tham số (CLI, không bắt buộc — không truyền thì được hỏi trên terminal):
//   --file <path>         File chứa danh sách CA, mỗi CA 1 dòng (mặc định ca-rug.txt)
//   --min-liq <n>          Chỉ hiển thị token có liq >= n USD (mặc định hỏi trên terminal, Enter = 0)
//   --concurrency <n>      Số request chạy song song (mặc định hỏi trên terminal, Enter = 10)
//   --mode <1|2>           1 = quét 1 lần, 2 = quét lặp mỗi N phút (mặc định hỏi trên terminal, Enter = 1)
//   --interval <phút>      Chỉ dùng khi mode=2 — số phút giữa các lần quét (mặc định hỏi trên terminal, Enter = 10)
//   --max-zero-streak <n>  Sau n lần quét LIÊN TIẾP token vẫn ra liquidity = 0 (hoặc không xác định
//                          được) thì xoá hẳn CA đó khỏi INPUT_FILE (mặc định 3). Đếm lưu ở file
//                          "<INPUT_FILE>.streak.json", không mất khi tắt/mở lại script.
//   --tries <n>            Số lần thử lại nếu không thấy liquidity (mặc định 1 = không thử lại, nhanh nhất)
//   --retry-delay <ms>     Thời gian chờ giữa các lần thử lại nếu --tries > 1 (mặc định 500ms)
//   --timeout <ms>         Timeout mỗi request API (mặc định 6000ms) — request treo sẽ bị hủy sau thời gian này
//   --verify               Đọc 2 lần cách nhau vài giây, lấy số THẤP HƠN (chính xác hơn, chậm hơn gấp đôi)
//
// Kết quả: chỉ in ra màn hình những token có liquidity >= mốc tối thiểu (sắp theo liquidity giảm dần). Không xuất file.

import fs from 'fs';
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { createTelegramNotifier, escapeHtml } from './src/telegram.mjs';
import { initRpc } from './src/rpcClient.mjs';
import { RPC_FILE_NAME } from './src/config.mjs';
import { getDevAddress, getTotalSupply, getBalanceOf } from './src/onchainStats.mjs';
import { getCurveLiqUsd } from './src/curveLiquidity.mjs';

// Bot Telegram RIÊNG cho checkLiquidity.mjs (khác bot của radar.mjs), đọc
// cấu hình từ telegram-checkliquidity.txt (2 dòng: bot token / chat id,
// đặt ở gốc project, ngang hàng telegram.txt).
const telegram = createTelegramNotifier('telegram-checkliquidity.txt');

function parseArgs() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key.startsWith('--')) {
      const name = key.slice(2);
      if (name === 'verify') {
        args[name] = true;
        continue;
      }
      args[name] = argv[i + 1];
      i++;
    }
  }
  return args;
}

const args = parseArgs();

const num = (v, def) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : def;
};

const INPUT_FILE = args.file || 'ca-rug.txt';
const TRIES = Math.max(1, parseInt(args.tries, 10) || 1);
const RETRY_DELAY_MS = num(args['retry-delay'], 500);
const TIMEOUT_MS = num(args.timeout, 6000);

// Sau MAX_ZERO_STREAK lần quét LIÊN TIẾP mà 1 token vẫn ra liquidity = 0 (hoặc
// không xác định được), xoá hẳn CA đó khỏi INPUT_FILE để các vòng quét sau
// không phải quét lại nữa (đỡ tốn RPC/API cho token gần như chắc chắn đã
// chết hẳn). Đếm số lần liên tiếp được lưu ra file riêng (STREAK_FILE) nên
// vẫn đúng dù chạy --mode 1 nhiều lần tách rời (không chỉ trong 1 phiên
// --mode 2), và không bị mất khi tắt/mở lại script.
// Đổi ngưỡng qua: --max-zero-streak <số lần>
const MAX_ZERO_STREAK = Math.max(1, parseInt(args['max-zero-streak'], 10) || 3);
const STREAK_FILE = `${INPUT_FILE}.streak.json`;

function loadZeroStreak() {
  try {
    const raw = fs.readFileSync(STREAK_FILE, 'utf8');
    const obj = JSON.parse(raw);
    return new Map(Object.entries(obj));
  } catch {
    return new Map();
  }
}

function saveZeroStreak(map) {
  try {
    fs.writeFileSync(STREAK_FILE, JSON.stringify(Object.fromEntries(map)), 'utf8');
  } catch (e) {
    console.error(`[-] Không ghi được ${STREAK_FILE}: ${e.message}`);
  }
}

// Ghi lại INPUT_FILE, bỏ đi các token trong removeSet.
//
// QUAN TRỌNG: KHÔNG dùng lại caList đã load từ lúc BẮT ĐẦU quét (caList đó có
// thể đã cũ vài giây tới vài phút, tuỳ quét bao nhiêu token) — vì trong lúc
// checkLiquidity.mjs đang quét, notifier.mjs (chạy song song trong
// radar.mjs) có thể đã append thêm token MỚI vào chính file này. Nếu ghi đè
// dựa trên snapshot cũ, các token mới đó sẽ bị xoá mất theo kiểu "vô tình"
// dù chúng chẳng liên quan gì tới token bị xoá do hết thanh khoản.
// => Đọc lại file NGAY TRƯỚC khi ghi (đọc-sửa-ghi sát nhau nhất có thể) để
// gồm luôn những dòng mới vừa được radar.mjs thêm vào, chỉ lọc bỏ đúng những
// token nằm trong removeSet.
function removeFromCaFile(filePath, removeSet) {
  const freshList = loadCaList(filePath);
  const kept = freshList.filter((c) => !removeSet.has(c.token));
  const lines = kept.map((c) => (c.curve ? `${c.token},${c.curve},${c.pairToken || ''}` : c.token));
  try {
    fs.writeFileSync(filePath, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
  } catch (e) {
    console.error(`[-] Không ghi lại được ${filePath}: ${e.message}`);
  }
}
const USE_VERIFY = Boolean(args.verify);

function timeoutSignal(ms) {
  return typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined;
}

// Lấy thêm social links (X/Telegram/Website) từ endpoint /tokens/{address}/info của GeckoTerminal
async function fetchGeckoSocials(token) {
  try {
    const url = `https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/${token}/info`;
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: timeoutSignal(TIMEOUT_MS) });
    if (!res.ok) return null;
    const attrs = (await res.json()).data?.attributes || {};
    const websites = Array.isArray(attrs.websites) ? attrs.websites : [];
    return {
      twitter: attrs.twitter_handle ? `https://x.com/${attrs.twitter_handle}` : null,
      telegram: attrs.telegram_handle ? `https://t.me/${attrs.telegram_handle}` : null,
      website: websites[0] || null,
    };
  } catch {
    return null;
  }
}

// Trích social links từ payload của DexScreener (đã có sẵn trong response pool, không cần call thêm)
function extractDexSocials(pair) {
  const socials = pair.info?.socials || [];
  const websites = pair.info?.websites || [];
  const find = (type) => socials.find((s) => String(s.type || '').toLowerCase() === type)?.url || null;
  return {
    twitter: find('twitter'),
    telegram: find('telegram'),
    website: websites[0]?.url || null,
  };
}

async function fetchGeckoLiq(token) {
  try {
    const url = `https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/${token}/pools`;
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: timeoutSignal(TIMEOUT_MS) });
    if (!res.ok) return null;
    const pools = (await res.json()).data || [];
    let bestLiq = -1;
    let best = null;
    for (const p of pools) {
      const liq = Number(p.attributes?.reserve_in_usd || 0);
      if (liq > bestLiq) {
        bestLiq = liq;
        best = p.attributes || {};
      }
    }
    if (!best || bestLiq <= 0) return null;
    const socials = await fetchGeckoSocials(token);
    return {
      source: 'gecko',
      liq: bestLiq,
      mc: Number(best.market_cap_usd || best.fdv_usd || 0),
      name: best.name || '',
      sym: '',
      twitter: socials?.twitter || null,
      telegram: socials?.telegram || null,
      website: socials?.website || null,
    };
  } catch {
    return null;
  }
}

async function fetchDexLiq(token) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`, { signal: timeoutSignal(TIMEOUT_MS) });
    if (!res.ok) return null;
    const pairs = (await res.json()).pairs || [];
    const rh = pairs.filter((p) => String(p.chainId || '').toLowerCase().includes('robinhood'));
    const pair = rh[0] || pairs[0];
    if (!pair) return null;
    const liq = Number(pair.liquidity?.usd || 0);
    if (liq <= 0) return null;
    const socials = extractDexSocials(pair);
    return {
      source: 'dex',
      liq,
      mc: Number(pair.marketCap || pair.fdv || 0),
      name: pair.baseToken?.name || '',
      sym: pair.baseToken?.symbol || '',
      twitter: socials.twitter,
      telegram: socials.telegram,
      website: socials.website,
    };
  } catch {
    return null;
  }
}

async function fetchLiqOnce(token) {
  const g = await fetchGeckoLiq(token);
  if (g) return g;
  return await fetchDexLiq(token);
}

async function fetchLiq(token, tries) {
  for (let i = 0; i < tries; i++) {
    const r = await fetchLiqOnce(token);
    if (r) return r;
    if (i < tries - 1) await new Promise((res) => setTimeout(res, RETRY_DELAY_MS));
  }
  return null;
}

async function fetchLiqVerified(token, tries) {
  const first = await fetchLiq(token, tries);
  if (!first) return null;
  await new Promise((r) => setTimeout(r, 2000));
  const second = await fetchLiq(token, 1);
  if (!second) return first;
  return second.liq <= first.liq ? second : first;
}

// Lấy % tổng cung mà ví dev (EOA đã tạo token, tra qua Blockscout - xem
// getDevAddress trong src/onchainStats.mjs) đang giữ NGAY LÚC NÀY, đọc
// on-chain qua RPC (totalSupply() + balanceOf(dev)). Trả về null nếu không
// tra được ví dev hoặc RPC lỗi (không throw ra ngoài, không chặn kết quả
// liquidity chính).
async function fetchDevHoldPct(token) {
  try {
    const devAddr = await getDevAddress(token);
    if (!devAddr) return null;
    const [totalSupply, devBal] = await Promise.all([
      getTotalSupply(token),
      getBalanceOf(token, devAddr),
    ]);
    if (totalSupply <= 0n) return null;
    return Number((devBal * 100000n) / totalSupply) / 1000;
  } catch {
    return null;
  }
}

// Hỏi trực tiếp trên terminal cho min-liq / max-liq / concurrency, để bạn
// tự nhập tay mỗi lần chạy thay vì phải nhớ cú pháp --flag. Nếu đã truyền
// sẵn qua CLI (--min-liq, --max-liq, --concurrency) thì bỏ qua câu hỏi
// tương ứng và dùng luôn giá trị CLI. Nhấn Enter (để trống) để lấy mặc định.
async function promptForSettings() {
  const rl = readline.createInterface({ input, output });
  const ask = async (question, def) => {
    const suffix = def === '' || def == null ? ' (Enter = không giới hạn)' : ` (Enter = ${def})`;
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer === '' ? undefined : answer;
  };

  let minLiqRaw = args['min-liq'];
  if (minLiqRaw === undefined) {
    minLiqRaw = await ask('Liquidity TỐI THIỂU (USD)', 0);
  }

  let concurrencyRaw = args.concurrency;
  if (concurrencyRaw === undefined) {
    concurrencyRaw = await ask('Concurrency (số request chạy song song)', 10);
  }

  let modeRaw = args.mode;
  if (modeRaw === undefined) {
    console.log('\nChọn chế độ chạy:');
    console.log('  1) Quét 1 lần rồi dừng');
    console.log('  2) Quét lặp lại (tự chọn số phút mỗi vòng, mỗi lần đọc lại nội dung mới nhất từ file CA)');
    modeRaw = await ask('Nhập lựa chọn', 1);
  }

  const repeat = String(modeRaw).trim() === '2';

  let intervalRaw;
  if (repeat) {
    intervalRaw = args.interval;
    if (intervalRaw === undefined) {
      intervalRaw = await ask('Quét lặp lại mỗi bao nhiêu PHÚT', 10);
    }
  }

  rl.close();

  return {
    minLiq: num(minLiqRaw, 0),
    concurrency: Math.max(1, parseInt(concurrencyRaw, 10) || 10),
    repeat,
    intervalMin: Math.max(1, num(intervalRaw, 10)),
  };
}

const ADDR_RE = /^0x[a-f0-9]{40}$/;

// Mỗi dòng có thể là:
//   0xTOKEN                          (file cũ, chỉ có token)
//   0xTOKEN,0xCURVE,0xPAIRTOKEN      (file mới do notifier.mjs ghi — xem appendCa)
// pairToken có thể để trống (native ETH) -> vẫn giữ nguyên chuỗi rỗng.
// Trả về mảng object { token, curve, pairToken } — curve/pairToken = null nếu
// không có, để nơi gọi tự biết có thể đọc on-chain trực tiếp hay không.
function loadCaList(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    console.error(`[-] Không đọc được file ${filePath}: ${e.message}`);
    process.exit(1);
  }
  const seen = new Set();
  const list = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const parts = trimmed.split(',').map((s) => s.trim().toLowerCase());
    const token = parts[0];
    if (!ADDR_RE.test(token)) continue; // bỏ qua dòng không phải địa chỉ hợp lệ
    if (seen.has(token)) continue;
    seen.add(token);

    const curve = parts[1] && ADDR_RE.test(parts[1]) ? parts[1] : null;
    const pairToken = curve && parts[2] ? parts[2] : null;
    list.push({ token, curve, pairToken });
  }
  return list;
}

// Chạy tối đa `limit` việc song song, không cần thư viện ngoài.
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runner() {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      results[idx] = await worker(items[idx], idx);
    }
  }

  const runners = Array.from({ length: Math.min(limit, items.length) }, runner);
  await Promise.all(runners);
  return results;
}

function buildLiqTelegramMessage(r) {
  const sym = r.sym || '?';
  const liqStr = r.liq == null ? 'n/a' : `$${r.liq.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  const mcStr = r.mc == null ? 'n/a' : `$${r.mc.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  const devPctStr = r.devPct == null ? 'n/a' : `${r.devPct.toFixed(2)}%`;
  const lines = [];
  lines.push(`💧 <b>Token có thanh khoản trở lại</b>   $${escapeHtml(sym)}  ${escapeHtml(r.name || '')}`);
  lines.push(`<b>CA</b>: <code>${escapeHtml(r.token)}</code>`);
  lines.push(`<b>Liq</b>: ${liqStr} (${escapeHtml(r.source || 'n/a')})`);
  lines.push(`<b>MC/FDV</b>: ${mcStr}`);
  lines.push(`<b>Dev hold</b>: ${devPctStr}`);
  if (r.twitter) lines.push(`<b>X</b>: ${escapeHtml(r.twitter)}`);
  if (r.telegram) lines.push(`<b>Telegram</b>: ${escapeHtml(r.telegram)}`);
  if (r.website) lines.push(`<b>Web</b>: ${escapeHtml(r.website)}`);
  lines.push(`<b>GMGN</b>: https://gmgn.ai/robinhood/token/${r.token}`);
  return lines.join('\n');
}

// Quét 1 lần: LUÔN đọc lại file CA mới nhất (loadCaList đọc file mỗi lần
// gọi), nên nếu radar.mjs vừa ghi thêm CA mới vào ca-rug.txt thì lần quét
// tiếp theo sẽ tự động thấy ngay.
async function runScanOnce(MIN_LIQ_USD, CONCURRENCY) {
  const caList = loadCaList(INPUT_FILE);
  if (caList.length === 0) {
    console.log(`[!] Không tìm thấy CA hợp lệ nào trong ${INPUT_FILE}.`);
    return;
  }

  console.log(`[*] Đang check thanh khoản cho ${caList.length} token từ ${INPUT_FILE}...`);
  console.log(
    `[*] Concurrency=${CONCURRENCY}  Tries=${TRIES}  Timeout=${TIMEOUT_MS}ms  Verify=${USE_VERIFY ? 'bật' : 'tắt'}  Lọc liq: >= $${MIN_LIQ_USD}\n`
  );

  const t0 = Date.now();
  let done = 0;
  const results = await runWithConcurrency(caList, CONCURRENCY, async ({ token, curve, pairToken }) => {
    let info = null;

    // Ưu tiên đọc thẳng số dư ví Curve on-chain (real-time, KHÔNG có cache) —
    // chỉ khả thi với các dòng mới do notifier.mjs ghi kèm curve/pairToken.
    // Đây là fix cho đúng bug đã gặp: GeckoTerminal/DexScreener index có độ
    // trễ, có thể vẫn trả về liquidity CŨ (từ trước lúc rug) trong nhiều
    // phút sau khi ví curve đã thực sự về gần $0 trên GMGN.
    // getCurveLiqUsd trả về null nếu: không có curve, token graduate sang
    // Uniswap v4 rồi (không tự nói lên được), hoặc quote asset là cổ phiếu
    // tokenized chưa quy đổi được USD ở đây -> những trường hợp đó fallback
    // xuống API ngoài như cũ.
    if (curve) {
      try {
        const onchain = await getCurveLiqUsd(curve, pairToken);
        if (onchain) info = { source: onchain.source, liq: onchain.liq, mc: null, name: '', sym: '' };
      } catch {}
    }

    if (!info) {
      try {
        info = USE_VERIFY ? await fetchLiqVerified(token, TRIES) : await fetchLiq(token, TRIES);
      } catch {}
    }

    // Chỉ tốn thêm request RPC/Blockscout tra % dev hold cho token THẬT SỰ
    // còn thanh khoản (liq > 0) — bỏ qua token đã xác nhận về $0 (dù qua
    // on-chain hay API) để đỡ tốn request vô ích cho hàng loạt token rác
    // trong ca-rug.txt.
    let devPct = null;
    if (info && info.liq > 0) {
      try {
        devPct = await fetchDevHoldPct(token);
      } catch {}
    }

    done++;
    if (done % 10 === 0 || done === caList.length) {
      process.stdout.write(`\r[*] Đã check ${done}/${caList.length}...`);
    }
    return {
      token,
      liq: info?.liq ?? null,
      mc: info?.mc ?? null,
      sym: info?.sym || '',
      name: info?.name || '',
      source: info?.source || '',
      twitter: info?.twitter || '',
      telegram: info?.telegram || '',
      website: info?.website || '',
      devPct,
    };
  });
  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n');

  results.sort((a, b) => (b.liq ?? -1) - (a.liq ?? -1));

  const filtered = results.filter((r) => r.liq != null && r.liq >= MIN_LIQ_USD);

  console.log(`Token                                        Liq (USD)      MC (USD)       Sym       Nguồn        DevHold   X/Twitter`);
  console.log(`${'-'.repeat(150)}`);
  if (filtered.length === 0) {
    console.log('(không có token nào khớp điều kiện lọc)');
  }
  for (const r of filtered) {
    const liqStr = r.liq == null ? 'n/a' : `$${r.liq.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
    const mcStr = r.mc == null ? 'n/a' : `$${r.mc.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
    const devPctStr = r.devPct == null ? 'n/a' : `${r.devPct.toFixed(2)}%`;
    console.log(`${r.token}  ${liqStr.padEnd(14)} ${mcStr.padEnd(14)} ${(r.sym || '?').padEnd(9)} ${(r.source || 'chưa index').padEnd(12)} ${devPctStr.padEnd(9)} ${r.twitter || ''}`);
    console.log(`  GMGN: https://gmgn.ai/robinhood/token/${r.token}`);

    // Báo Telegram cho MỌI token khớp điều kiện lọc ở MỌI vòng quét (kể cả
    // đã báo ở vòng trước, miễn vẫn còn đủ điều kiện) — không dedup theo
    // phiên chạy nữa, theo yêu cầu.
    if (telegram.telegramEnabled) {
      telegram.sendTelegramMessage(buildLiqTelegramMessage(r)).catch(() => {});
    }
  }

  const withLiq = results.filter((r) => r.liq != null && r.liq > 0).length;
  console.log(`\n[*] Xong trong ${elapsedSec}s. ${filtered.length}/${results.length} token khớp điều kiện lọc (tổng ${withLiq} token có thanh khoản > 0).`);

  // Cập nhật streak "liên tiếp không có thanh khoản" cho từng token, xoá
  // khỏi INPUT_FILE những token đã đạt ngưỡng MAX_ZERO_STREAK.
  const zeroStreak = loadZeroStreak();
  const toRemove = new Set();
  for (const r of results) {
    const hasLiq = r.liq != null && r.liq > 0;
    if (hasLiq) {
      zeroStreak.delete(r.token);
      continue;
    }
    const count = (zeroStreak.get(r.token) || 0) + 1;
    if (count >= MAX_ZERO_STREAK) {
      toRemove.add(r.token);
      zeroStreak.delete(r.token); // không cần theo dõi nữa vì sắp xoá khỏi file
    } else {
      zeroStreak.set(r.token, count);
    }
  }
  saveZeroStreak(zeroStreak);

  if (toRemove.size > 0) {
    removeFromCaFile(INPUT_FILE, toRemove);
    console.log(`[*] Đã xoá ${toRemove.size} CA khỏi ${INPUT_FILE} (liquidity = 0 sau ${MAX_ZERO_STREAK} lần quét liên tiếp).`);
  }
}

async function main() {
  const { minLiq: MIN_LIQ_USD, concurrency: CONCURRENCY, repeat, intervalMin } = await promptForSettings();
  const INTERVAL_MS = intervalMin * 60 * 1000;

  const rpcOk = await initRpc();
  if (!rpcOk) {
    console.log(`[!] Không kết nối được RPC nào (kiểm tra file ${RPC_FILE_NAME}) - cột "Dev hold" sẽ hiển thị n/a, phần liquidity vẫn chạy bình thường.\n`);
  }

  await telegram.verifyTelegramConnection();

  if (!repeat) {
    console.log('\n[*] Chế độ: quét 1 lần rồi dừng.\n');
    await runScanOnce(MIN_LIQ_USD, CONCURRENCY);
    return;
  }

  console.log(`\n[*] Chế độ: quét lặp lại mỗi ${intervalMin} phút. Nhấn Ctrl+C để dừng.\n`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const startedAt = new Date().toLocaleString('vi-VN');
    console.log(`\n${'='.repeat(60)}\n[${startedAt}] Bắt đầu vòng quét mới\n${'='.repeat(60)}`);
    try {
      await runScanOnce(MIN_LIQ_USD, CONCURRENCY);
    } catch (e) {
      console.error(`[-] Lỗi trong vòng quét: ${e.message}`);
    }
    const nextAt = new Date(Date.now() + INTERVAL_MS).toLocaleString('vi-VN');
    console.log(`\n[*] Chờ ${INTERVAL_MS / 60000} phút... (vòng tiếp theo lúc ${nextAt})`);
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main().catch((e) => {
  console.error(`[-] Lỗi chạy checkLiquidity: ${e.message}`);
  process.exit(1);
});
