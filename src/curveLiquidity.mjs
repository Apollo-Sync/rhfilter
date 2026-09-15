import { rpc } from './rpcClient.mjs';
import { quoteSymbol } from './format.mjs';

// ─── Đọc thanh khoản THẬT trực tiếp on-chain từ ví Curve ──────────────────
// Theo tài liệu chính thức của Pons v2: mỗi token launch có 1 bonding-curve
// contract RIÊNG (chính là địa chỉ `curve` trong event TokenLaunched), giữ
// TOÀN BỘ quote asset (ETH mặc định, hoặc USDG/cbBTC/cổ phiếu tokenized nếu
// creator chọn) mà người mua đã bỏ vào, cho tới khi graduate sang Uniswap
// v4. Curve "luôn sẵn sàng mua/bán" nên số dư của nó tại bất kỳ thời điểm
// nào CHÍNH LÀ thanh khoản thật, không phải số liệu tổng hợp/cache của
// GeckoTerminal hay DexScreener (vốn có độ trễ index, đã gây ra bug báo
// $5,397 trong khi thực tế chỉ còn $4.84).
//
// Đọc thẳng bằng 1 lệnh RPC (eth_getBalance hoặc balanceOf) là real-time
// 100%, không có khái niệm "cache" ở đây.

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

// Giá ETH-USD được cache ngắn hạn để không gọi API giá dồn dập — ETH-USD
// biến động chậm hơn NHIỀU so với giá 1 memecoin mới launch, nên độ trễ vài
// chục giây ở đây gần như không ảnh hưởng tới độ chính xác của kết quả
// cuối cùng (khác hẳn với việc cache thẳng USD-liquidity của cả 1 token mới).
let ethPriceCache = { price: null, ts: 0 };
const ETH_PRICE_CACHE_MS = 20_000;

async function getEthUsdPrice() {
  const now = Date.now();
  if (ethPriceCache.price && now - ethPriceCache.ts < ETH_PRICE_CACHE_MS) {
    return ethPriceCache.price;
  }
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd"
    );
    if (res.ok) {
      const data = await res.json();
      const price = Number(data?.ethereum?.usd);
      if (Number.isFinite(price) && price > 0) {
        ethPriceCache = { price, ts: now };
        return price;
      }
    }
  } catch {}
  // API giá lỗi tạm thời -> thà dùng giá cache cũ (nếu có) còn hơn không có gì
  return ethPriceCache.price;
}

async function getErc20Decimals(tokenAddr) {
  try {
    const res = await rpc("eth_call", [{ to: tokenAddr, data: "0x313ce567" }, "latest"]); // decimals()
    const d = parseInt(res, 16);
    return Number.isFinite(d) ? d : 18;
  } catch {
    return 18;
  }
}

async function getErc20BalanceOf(tokenAddr, holder) {
  const paddedAddr = holder.replace("0x", "").padStart(64, "0");
  const res = await rpc("eth_call", [
    { to: tokenAddr, data: "0x70a08231" + paddedAddr },
    "latest",
  ]);
  return BigInt(res || "0x0");
}

// Các quote asset coi như neo giá ~$1 (stablecoin). Hiện chỉ USDG được Pons
// hỗ trợ chính thức trong nhóm này (theo tài liệu). Thêm ký hiệu khác vào
// đây nếu Pons hỗ trợ thêm stablecoin mới.
const STABLE_QUOTE_SYMBOLS = new Set(["usdg"]);

/**
 * Đọc thanh khoản thật (USD) đang nằm trong ví bonding curve của 1 token,
 * bằng cách gọi thẳng RPC — không qua GeckoTerminal/DexScreener.
 *
 * Trả về null nếu:
 * - Token đã graduate (curve không còn giữ tiền — không thể suy ra từ đây,
 *   nên nếu số dư = 0 vẫn trả về liq: 0 một cách hợp lệ, KHÔNG trả null),
 * - Quote asset là cổ phiếu tokenized hoá hoặc tài sản chưa hỗ trợ quy đổi
 *   USD ở đây (NVDA, AAPL, HOOD...) — lúc này nơi gọi nên tự fallback về
 *   nguồn API ngoài (getLiqVerified) để vẫn có số liệu USD hiển thị,
 * - Có lỗi RPC.
 */
export async function getCurveLiqUsd(curveAddress, pairToken) {
  if (!curveAddress) return null;

  try {
    const isNativeEth = !pairToken || pairToken.toLowerCase() === ZERO_ADDR;

    let rawBalance;
    let decimals;
    let quoteSym;

    if (isNativeEth) {
      const balHex = await rpc("eth_getBalance", [curveAddress, "latest"]);
      rawBalance = BigInt(balHex || "0x0");
      decimals = 18;
      quoteSym = "ETH";
    } else {
      rawBalance = await getErc20BalanceOf(pairToken, curveAddress);
      decimals = await getErc20Decimals(pairToken);
      quoteSym = quoteSymbol(pairToken) || "";
    }

    const amount = Number(rawBalance) / 10 ** decimals;

    let usdPrice = null;
    if (quoteSym === "ETH") {
      usdPrice = await getEthUsdPrice();
    } else if (STABLE_QUOTE_SYMBOLS.has(quoteSym.toLowerCase())) {
      usdPrice = 1;
    } else {
      // Quote là cổ phiếu tokenized hoá hoặc tài sản không xác định được giá
      // ở đây -> để nơi gọi tự fallback sang nguồn khác.
      return null;
    }

    if (!Number.isFinite(usdPrice) || usdPrice <= 0) return null;

    return {
      source: "onchain-curve",
      liq: amount * usdPrice,
      quoteAmount: amount,
      quoteSym,
    };
  } catch {
    return null;
  }
}
