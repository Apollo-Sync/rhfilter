// scanDevSold.mjs
//
// Quét lại các token ĐÃ launch từ trước (không real-time), tìm token mà:
//   1) Dev đã có giao dịch "DS" THẬT (Transfer thẳng từ ví dev vào ví
//      curve/pool — đúng như cách GMGN gắn nhãn DS), VÀ
//   2) % tổng cung dev còn giữ hiện tại đã về gần 0, VÀ
//   3) Thanh khoản hiện tại nằm trong khoảng [MIN_LIQ_USD, MAX_LIQ_USD] bạn chọn.
//
// Đây là các token "cũ" mà dev đã xả xong nhưng vẫn còn sống — ứng viên
// tiềm năng bị bỏ sót lúc mới launch (ví dụ lúc đó chưa bật requireDevDumped,
// hoặc launch trước khi bot chạy).
//
// Cách chạy:
//   node scanDevSold.mjs
//   node scanDevSold.mjs --from 1200000 --to 1500000 --min-liq 500 --max-liq 20000
//
// Hoặc set qua biến môi trường (không truyền thì dùng mặc định):
//   FROM_BLOCK, TO_BLOCK, LOOKBACK_BLOCKS (nếu không có FROM_BLOCK),
//   MIN_LIQ_USD, MAX_LIQ_USD, ZERO_PCT_THRESHOLD
//
// Kết quả khớp được ghi nối vào ca-devsold.txt (mỗi CA 1 dòng) + in ra màn hình.

import fs from 'fs';
import { latestBlock } from './src/rpcClient.mjs';
import { getLogs } from './src/logs.mjs';
import { getCurveLiqUsd } from './src/curveLiquidity.mjs';
import { getLiq } from './src/liquidity.mjs';
import { getDevAddress, checkDevSoldOut } from './src/onchainStats.mjs';
import { decodeTokenLaunched } from './src/format.mjs';

function parseArgs() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key.startsWith('--')) {
      const name = key.slice(2);
      const val = argv[i + 1];
      args[name] = val;
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

const DEFAULT_LOOKBACK_BLOCKS = 200_000; // ~5.5h ở block time ~0.1s — chỉnh tùy nhu cầu
const MIN_LIQ_USD = num(args['min-liq'] ?? process.env.MIN_LIQ_USD, 0);
const MAX_LIQ_USD = num(args['max-liq'] ?? process.env.MAX_LIQ_USD, Infinity);
const ZERO_PCT_THRESHOLD = num(args['zero-pct'] ?? process.env.ZERO_PCT_THRESHOLD, 0.5);
const LOOKBACK_BLOCKS = num(args['lookback'] ?? process.env.LOOKBACK_BLOCKS, DEFAULT_LOOKBACK_BLOCKS);

const CA_DEVSOLD_FILE = 'ca-devsold.txt';

function appendCa(token) {
  try {
    fs.appendFileSync(CA_DEVSOLD_FILE, token + "\n", "utf8");
  } catch (e) {
    console.error(`[-] Không ghi được CA vào ${CA_DEVSOLD_FILE}: ${e.message}`);
  }
}

async function getCurrentLiqUsd(token, curve, pairToken) {
  try {
    const onchain = await getCurveLiqUsd(curve, pairToken);
    if (onchain) return onchain.liq;
  } catch {}
  try {
    const info = await getLiq(token, 1);
    if (info) return info.liq || 0;
  } catch {}
  return null; // không xác định được -> để nơi gọi tự quyết định có loại hay không
}

async function main() {
  const latest = await latestBlock();
  const fromBlock = args.from != null ? parseInt(args.from, 10) : Math.max(0, latest - LOOKBACK_BLOCKS);
  const toBlock = args.to != null ? parseInt(args.to, 10) : latest;

  console.log(`[*] Quét token launch từ block ${fromBlock} -> ${toBlock} (latest: ${latest})`);
  console.log(`[*] Điều kiện: có DS thật, dev còn giữ <= ${ZERO_PCT_THRESHOLD}%, liquidity trong [$${MIN_LIQ_USD}, ${MAX_LIQ_USD === Infinity ? "∞" : "$" + MAX_LIQ_USD}]`);
  console.log("");

  const launchLogs = await getLogs(fromBlock, toBlock);
  console.log(`[*] Tìm thấy ${launchLogs.length} token đã launch trong khoảng này.\n`);

  let matched = 0;

  for (let i = 0; i < launchLogs.length; i++) {
    const log = launchLogs[i];
    const launch = decodeTokenLaunched(log);
    const token = launch.token;
    if (!token) continue;

    const launchBlockNum = parseInt(log.blockNumber, 16);
    process.stdout.write(`[${i + 1}/${launchLogs.length}] ${token} ... `);

    try {
      let devAddr = null;
      try {
        devAddr = await getDevAddress(token);
      } catch {}
      if (!devAddr) devAddr = launch.deployer;

      const result = await checkDevSoldOut(token, devAddr, launch.curve, launchBlockNum, latest, ZERO_PCT_THRESHOLD);

      if (!result.sold) {
        console.log(`bỏ qua (sellCount=${result.sellCount}, devPct=${result.devPct ?? "n/a"})`);
        continue;
      }

      const liq = await getCurrentLiqUsd(token, launch.curve, launch.pairToken);
      if (liq == null) {
        console.log(`DS ✅ nhưng không xác định được liquidity -> bỏ qua`);
        continue;
      }
      if (liq < MIN_LIQ_USD || liq > MAX_LIQ_USD) {
        console.log(`DS ✅ nhưng liquidity $${liq.toFixed(2)} ngoài khoảng -> bỏ qua`);
        continue;
      }

      matched++;
      console.log(`✅ KHỚP — devPct=${result.devPct}%, sellCount=${result.sellCount}, liq=$${liq.toFixed(2)}`);
      appendCa(token);
    } catch (e) {
      console.log(`lỗi: ${e.message}`);
    }
  }

  console.log(`\n[*] Xong. ${matched} token khớp điều kiện, đã ghi vào ${CA_DEVSOLD_FILE}.`);
}

main().catch((e) => {
  console.error(`[-] Lỗi chạy scanDevSold: ${e.message}`);
  process.exit(1);
});
