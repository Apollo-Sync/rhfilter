import { rpc, latestBlock } from './rpcClient.mjs';
import { TRANSFER_TOPIC, CHUNK_SIZE, BLOCKSCOUT_API } from './config.mjs';
import { printPermanent } from './screen.mjs';

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

// Chia nhỏ dải block theo CHUNK_SIZE (giống getLogs) để không vượt giới hạn của RPC free plan
export async function fetchTransferLogs(token, startBlock, endBlock) {
  let allLogs = [];
  let currentStart = startBlock;

  while (currentStart <= endBlock) {
    const currentEnd = Math.min(currentStart + CHUNK_SIZE - 1, endBlock);
    try {
      const logs = await rpc("eth_getLogs", [{
        address: token,
        topics: [TRANSFER_TOPIC],
        fromBlock: "0x" + currentStart.toString(16),
        toBlock: "0x" + currentEnd.toString(16)
      }]);
      if (Array.isArray(logs)) {
        allLogs.push(...logs);
      }
    } catch (e) {
      printPermanent(`[DEBUG] Lỗi lấy logs transfer của token ${token} (block ${currentStart}-${currentEnd}): ${e.message}`);
    }
    currentStart = currentEnd + 1;
  }
  return allLogs;
}

function collectHoldersAndSnipers(logs, targetBlockNum) {
  const addresses = new Set();
  const txSendersInFirstBlock = new Set();

  for (const l of logs) {
    if (l.topics && l.topics[1] && l.topics[2]) {
      const fromAddr = "0x" + l.topics[1].slice(26).toLowerCase();
      const toAddr = "0x" + l.topics[2].slice(26).toLowerCase();

      addresses.add(fromAddr);
      addresses.add(toAddr);

      if (targetBlockNum > 0 && parseInt(l.blockNumber, 16) === targetBlockNum) {
        if (fromAddr === ZERO_ADDR) {
          txSendersInFirstBlock.add(toAddr);
        }
      }
    }
  }
  addresses.delete(ZERO_ADDR);
  return { addresses, txSendersInFirstBlock };
}

// Blockscout (đứng sau Cloudflare) hay trả 403 cho request không có
// User-Agent giống trình duyệt thật (Node fetch mặc định gửi UA kiểu
// "node"/"undici" rất dễ bị WAF chặn). Header dưới đây giả lập trình duyệt,
// đồng thời thử lại nếu bị 403/429/5xx (có thể do rate-limit/chặn tạm thời).
const BROWSER_HEADERS = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Referer: "https://robinhoodchain.blockscout.com/",
};

async function fetchBlockscout(path, label, token) {
  let lastStatus = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${BLOCKSCOUT_API}${path}`, { headers: BROWSER_HEADERS });
      if (res.ok) return await res.json();
      lastStatus = res.status;
      // 403/429 -> có thể do chặn/rate-limit tạm thời, chờ rồi thử lại
      if ((res.status === 403 || res.status === 429 || res.status >= 500) && attempt < 3) {
        await new Promise(r => setTimeout(r, 500 * attempt));
        continue;
      }
      break;
    } catch (e) {
      printPermanent(`[DEBUG] Lỗi gọi Blockscout ${label} cho ${token}: ${e.message}`);
      return null;
    }
  }
  printPermanent(`[DEBUG] Blockscout ${label} trả về lỗi ${lastStatus} cho ${token} (đã thử lại)`);
  return null;
}

// Cache theo token để không tra Blockscout lặp lại nhiều lần cho cùng 1
// token (getOnChainStats và notifier.mjs — vòng lặp waitForDevDump — đều
// cần gọi hàm này cho cùng 1 token).
const devAddrCache = new Map();

// Tra ra ví dev THẬT (EOA đã gọi tạo token) qua Blockscout API.
//
// Lưu ý quan trọng: address "deployer" nằm trong event TokenLaunched (và
// được decode ở format.mjs) đôi khi KHÔNG phải ví dev trực tiếp — nếu dev
// tạo token qua 1 router/relayer trung gian, giá trị đó sẽ là địa chỉ
// router/relayer chứ không phải ví người dùng thật, khiến % dev hold được
// tính hoàn toàn sai (theo dõi nhầm ví). Cách chính xác (giống GMGN) là tra
// ngược transaction đã tạo token (creation_tx_hash) và lấy field "from" của
// tx đó — đó mới là ví EOA đã ký giao dịch tạo token.
export async function getDevAddress(token) {
  const key = token.toLowerCase();
  if (devAddrCache.has(key)) return devAddrCache.get(key);

  const result = await (async () => {
    const data = await fetchBlockscout(`/addresses/${token}`, "/addresses", token);
    if (!data) return null;

    const creationTxHash = data?.creation_tx_hash || data?.creation_transaction_hash;
    if (creationTxHash) {
      const txData = await fetchBlockscout(`/transactions/${creationTxHash}`, "/transactions", token);
      const sender = txData?.from?.hash;
      if (sender) return sender.toLowerCase();
      if (txData) printPermanent(`[DEBUG] Tx tạo token ${token} (${creationTxHash}) không có field "from"`);
    }

    // Fallback: dùng creator_address_hash nếu không tra được tx tạo token
    // (có thể là router/relayer chứ không hẳn là dev thật, nhưng còn hơn n/a).
    const dev = data?.creator_address_hash;
    if (!dev) {
      printPermanent(`[DEBUG] Blockscout không trả về creator_address_hash lẫn creation_tx_hash cho ${token}`);
    }
    return dev ? dev.toLowerCase() : null;
  })();

  devAddrCache.set(key, result);
  return result;
}

async function fetchBalances(token, addrArray) {
  const balances = [];
  for (const addr of addrArray) {
    try {
      const paddedAddr = addr.replace("0x", "").padStart(64, "0");
      const data = "0x70a08231" + paddedAddr; // balanceOf(address)
      const balHex = await rpc("eth_call", [{ to: token, data }, "latest"]);
      const bal = BigInt(balHex || "0x0");
      if (bal > 0n) {
        balances.push({ addr, bal });
      }
    } catch {}
  }
  return balances;
}

// Lấy tổng cung token qua totalSupply()
export async function getTotalSupply(token) {
  try {
    const res = await rpc("eth_call", [{ to: token, data: "0x18160ddd" }, "latest"]);
    return BigInt(res || "0x0");
  } catch {
    return 0n;
  }
}

// Lấy số dư token hiện tại của 1 địa chỉ qua balanceOf(address)
export async function getBalanceOf(token, address) {
  try {
    const paddedAddr = address.replace("0x", "").padStart(64, "0");
    const data = "0x70a08231" + paddedAddr;
    const res = await rpc("eth_call", [{ to: token, data }, "latest"]);
    return BigInt(res || "0x0");
  } catch {
    return 0n;
  }
}

// Kiểm tra dev/deployer đã "xả" (gần) hết hàng hay chưa, dựa trên % số dư
// hiện tại của ví deployer so với tổng cung. thresholdPct=2 nghĩa là dev còn
// giữ dưới 2% tổng cung thì coi như đã xả hết.
//
// QUAN TRỌNG: tham số `deployer` phải là địa chỉ dev THẬT (lấy từ
// getDevAddress(token) ở trên), KHÔNG dùng thẳng launch.deployer decode từ
// event TokenLaunched — vì đó có thể là router/relayer, khiến % tính ra sai
// hoàn toàn (theo dõi nhầm ví, không phản ánh đúng việc dev có xả hàng
// hay không).
export async function hasDevDumped(token, deployer, thresholdPct) {
  try {
    const [totalSupply, devBal] = await Promise.all([
      getTotalSupply(token),
      getBalanceOf(token, deployer),
    ]);
    if (totalSupply <= 0n) return { dumped: false, pct: null };
    const pct = Number((devBal * 100000n) / totalSupply) / 1000;
    return { dumped: pct <= thresholdPct, pct };
  } catch (e) {
    return { dumped: false, pct: null };
  }
}

// Phân loại giao dịch Transfer của ví DEV giống cách GMGN gắn nhãn:
// - "DB" (Dev Buy):  curve -> dev   (dev mua token qua bonding curve)
// - "DS" (Dev Sell): dev -> curve   (dev bán token vào bonding curve)
// Đây là cách xác định CHÍNH XÁC hơn nhiều so với chỉ nhìn số dư dev giảm —
// vì số dư giảm có thể do dev chuyển sang ví khác (không phải bán thật,
// không đẩy giá xuống), còn Transfer thẳng vào curve mới chắc chắn là 1
// lệnh bán thật trên thị trường.
export function classifyDevTransfers(logs, devAddr, curveAddr) {
  const dev = devAddr?.toLowerCase();
  const curve = curveAddr?.toLowerCase();
  const buys = [];
  const sells = [];
  if (!dev || !curve) return { buys, sells };

  for (const l of logs) {
    if (!l.topics || !l.topics[1] || !l.topics[2]) continue;
    const fromAddr = "0x" + l.topics[1].slice(26).toLowerCase();
    const toAddr = "0x" + l.topics[2].slice(26).toLowerCase();
    if (fromAddr === curve && toAddr === dev) {
      buys.push({ blockNumber: parseInt(l.blockNumber, 16), txHash: l.transactionHash });
    } else if (fromAddr === dev && toAddr === curve) {
      sells.push({ blockNumber: parseInt(l.blockNumber, 16), txHash: l.transactionHash });
    }
  }
  return { buys, sells };
}

// Quét 1 token trong khoảng block [fromBlock, toBlock], xác định:
// - dev đã từng có giao dịch "DS" (bán thẳng vào curve) hay chưa
// - % tổng cung dev đang giữ NGAY LÚC NÀY
// "sold" = true khi CẢ HAI đúng: (1) có ít nhất 1 giao dịch DS thật, VÀ
// (2) % hiện tại đã về gần 0 (<= zeroPctThreshold). Bắt buộc cả 2 điều
// kiện để tránh 2 kiểu báo sai: chỉ nhìn % (dev có thể chưa từng mua nên
// 0% ngay từ đầu) hoặc chỉ nhìn có DS (dev bán 1 phần nhỏ rồi vẫn ôm phần
// lớn còn lại).
export async function checkDevSoldOut(token, devAddr, curveAddr, fromBlock, toBlock, zeroPctThreshold = 0.5) {
  if (!devAddr || !curveAddr) return { sold: false, sellCount: 0, buyCount: 0, devPct: null, lastSell: null };

  const logs = await fetchTransferLogs(token, fromBlock, toBlock);
  const { buys, sells } = classifyDevTransfers(logs, devAddr, curveAddr);

  const [totalSupply, devBal] = await Promise.all([
    getTotalSupply(token),
    getBalanceOf(token, devAddr),
  ]);
  const devPct = totalSupply > 0n ? Number((devBal * 100000n) / totalSupply) / 1000 : null;

  return {
    sold: sells.length > 0 && devPct != null && devPct <= zeroPctThreshold,
    sellCount: sells.length,
    buyCount: buys.length,
    devPct,
    lastSell: sells.length > 0 ? sells[sells.length - 1] : null,
  };
}

// Kiểm tra token có còn phát sinh giao dịch (Transfer) "thật" sau block
// launch hay không — dùng để phát hiện token đã bị rug/hết thanh khoản/hết
// vol sớm. fromBlock nên là block launch + 1 để bỏ qua các Transfer mint
// ban đầu.
//
// excludeAddress (thường là ví deployer): NẾU không loại trừ, chính giao
// dịch dev xả hàng (Transfer từ ví dev) cũng sẽ bị tính nhầm là "vẫn còn
// giao dịch" — trong khi đó chỉ là dev bán xong rồi im luôn, không có ai
// mua/bán gì thêm. Nên chỉ tính các Transfer không dính đến ví bị loại trừ
// là bằng chứng "còn giao dịch thật".
export async function hasTradingActivitySince(token, fromBlock, toBlock, excludeAddress = null) {
  if (fromBlock > toBlock) return false;
  try {
    const logs = await fetchTransferLogs(token, fromBlock, toBlock);
    if (!excludeAddress) return logs.length > 0;

    const excl = excludeAddress.toLowerCase();
    return logs.some((l) => {
      if (!l.topics || !l.topics[1] || !l.topics[2]) return false;
      const fromAddr = "0x" + l.topics[1].slice(26).toLowerCase();
      const toAddr = "0x" + l.topics[2].slice(26).toLowerCase();
      return fromAddr !== excl && toAddr !== excl;
    });
  } catch (e) {
    return false;
  }
}

// Đã tối ưu hóa dải block và bật log lỗi chi tiết để tránh lỗi n/a
export async function getOnChainStats(token, creationBlockHex) {
  try {
    const currentBlock = await latestBlock();

    // 1. Lấy tổng cung token (totalSupply)
    const totalSupplyRes = await rpc("eth_call", [{
      to: token,
      data: "0x18160ddd" // totalSupply()
    }, "latest"]);
    const totalSupply = BigInt(totalSupplyRes || "0x0");

    // Thu hẹp dải block quét trong 150 block gần nhất để không bị RPC node từ chối
    const startBlock = Math.max(0, currentBlock - 150);

    // Tra ví dev THẬT (qua Blockscout, xem getDevAddress ở trên) song song
    // với quét log Transfer để đỡ tốn thời gian.
    const [logs, devAddr] = await Promise.all([
      fetchTransferLogs(token, startBlock, currentBlock),
      getDevAddress(token),
    ]);

    let devPct = null;
    if (devAddr && totalSupply > 0n) {
      const devBal = await getBalanceOf(token, devAddr);
      devPct = Number((devBal * 10000n) / totalSupply) / 100;
    }

    const targetBlockNum = creationBlockHex ? parseInt(creationBlockHex, 16) : 0;
    const { addresses, txSendersInFirstBlock } = collectHoldersAndSnipers(logs, targetBlockNum);

    // Lấy tối đa 30 địa chỉ để gọi balanceOf tránh quá tải RPC request
    const addrArray = Array.from(addresses).slice(0, 30);
    const balances = await fetchBalances(token, addrArray);

    balances.sort((a, b) => (b.bal > a.bal ? 1 : -1));
    const holderCount = addresses.size > 0 ? addresses.size : balances.length;

    let top10Sum = 0n;
    for (let i = 0; i < Math.min(10, balances.length); i++) {
      top10Sum += balances[i].bal;
    }

    let top10Rate = null;
    if (totalSupply > 0n && top10Sum > 0n) {
      top10Rate = Number((top10Sum * 10000n) / totalSupply) / 100;
    }

    const sniperCount = txSendersInFirstBlock.size > 0
      ? `${txSendersInFirstBlock.size} / ${holderCount}`
      : `0 / ${holderCount}`;

    return {
      holders: holderCount > 0 ? holderCount : null,
      top10: top10Rate,
      snipers: sniperCount,
      devPct,
      devAddr
    };
  } catch (e) {
    printPermanent(`[DEBUG] Tổng quan lỗi getOnChainStats cho ${token}: ${e.message}`);
    return null;
  }
}
