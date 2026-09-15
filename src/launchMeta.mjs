import { ethers } from 'ethers';
import { rpc } from './rpcClient.mjs';

// Struct LaunchParams của Pons V2 (theo tài liệu Bitquery):
// (string name, string symbol, string logo, string description,
//  (string twitter, string telegram, string discord, string website, string farcaster) socials,
//  address creatorFeeRecipient, uint16 creatorTaxBps, bool buybackEnabled,
//  bytes32 expectedEconomics, bytes32 salt)
const LAUNCH_PARAMS_TUPLE =
  "tuple(string,string,string,string,tuple(string,string,string,string,string),address,uint16,bool,bytes32,bytes32)";

// Chỉ cần các selector xuất hiện ở TOP-LEVEL transaction input.
// launchTokenFor (0xd6a0eef5) chỉ được router gọi nội bộ, không nằm ở top-level nên bỏ qua.
const LAUNCH_SELECTORS = {
  // launchToken(params, launchConfigId, pairToken)
  "0xf35abbcf": [LAUNCH_PARAMS_TUPLE, "uint256", "address"],
  // launchToken(params, launchConfigId, pairToken, snipeTaxExemptions[])
  "0xa72101af": [LAUNCH_PARAMS_TUPLE, "uint256", "address", "address[]"],
  // launchAndBuy(params, launchConfigId, pairToken, quoteIn, minTokensOut, recipient, snipeTaxExemptions[])
  "0xf85f8e41": [LAUNCH_PARAMS_TUPLE, "uint256", "address", "uint256", "uint256", "address", "address[]"],
};

const abiCoder = ethers.AbiCoder.defaultAbiCoder();
const cache = new Map();

// Đọc transaction theo hash, giải mã calldata để lấy tên/mô tả/social links
// (X, Telegram, Website...) — thông tin này KHÔNG có trong event log,
// chỉ nằm trong tham số gọi hàm launch.
export async function getLaunchSocials(txHash) {
  if (cache.has(txHash)) return cache.get(txHash);

  let result = null;
  try {
    const tx = await rpc("eth_getTransactionByHash", [txHash]);
    const input = tx?.input || tx?.data;

    if (input && input.length >= 10) {
      const selector = input.slice(0, 10).toLowerCase();
      const types = LAUNCH_SELECTORS[selector];

      if (types) {
        const decoded = abiCoder.decode(types, "0x" + input.slice(10));
        const p = decoded[0];       // LaunchParams
        const socials = p[4];       // (twitter, telegram, discord, website, farcaster)

        result = {
          name: p[0] || null,
          symbol: p[1] || null,
          description: p[3] || null,
          twitter: socials[0] || null,
          telegram: socials[1] || null,
          discord: socials[2] || null,
          website: socials[3] || null,
          farcaster: socials[4] || null,
        };
      }
    }
  } catch (e) {
    // Không decode được (selector lạ / RPC lỗi) -> coi như không có info
    result = null;
  }

  cache.set(txHash, result);
  return result;
}
