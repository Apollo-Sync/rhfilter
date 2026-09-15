import { QUOTE_TOKENS } from './config.mjs';

export const now = () =>
  new Date().toLocaleTimeString("vi-VN", { hour12: false });

export const fmtPct = (x) => (x == null ? "n/a" : `${x.toFixed(2)}%`);

export function topicToAddr(topic) {
  if (!topic || topic.length < 66) return "";
  return ("0x" + topic.slice(26)).toLowerCase();
}

// Giải mã log TokenLaunched(address indexed token, address indexed curve,
// address indexed deployer, address pairToken, uint256 launchConfigId,
// uint256 graduationThreshold) — token/curve/deployer nằm trong topics,
// pairToken + launchConfigId + graduationThreshold nằm trong data.
export function decodeTokenLaunched(log) {
  const token = topicToAddr(log.topics?.[1]);
  const curve = topicToAddr(log.topics?.[2]);
  const deployer = topicToAddr(log.topics?.[3]);

  const data = (log.data || "0x").slice(2);
  const word = (i) => data.slice(i * 64, (i + 1) * 64);

  const pairToken = data.length >= 64 ? ("0x" + word(0).slice(24)).toLowerCase() : "";
  const launchConfigId = data.length >= 128 ? BigInt("0x" + word(1)) : 0n;
  const graduationThreshold = data.length >= 192 ? BigInt("0x" + word(2)) : 0n;

  return { token, curve, deployer, pairToken, launchConfigId, graduationThreshold };
}

export function quoteSymbol(pairToken) {
  if (!pairToken) return null;
  return QUOTE_TOKENS[pairToken.toLowerCase()] || null;
}

// Link search X theo ticker ($TICKER)
export function xTickerSearch(sym) {
  if (!sym) return null;
  const q = encodeURIComponent(`$${sym}`);
  return `https://x.com/search?q=${q}&f=live`;
}

// Link search X theo địa chỉ contract (để bắt tweet nhắc thẳng CA)
export function xCaSearch(token) {
  if (!token) return null;
  return `https://x.com/search?q=${token}&f=live`;
}
