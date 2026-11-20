import { parseAbi } from 'viem';
import { BSC_PANCAKE } from '@rushr/core/chain/pancake';

// Original v3 SwapRouter, not SmartRouter/UniversalRouter: tuple includes deadline.
// https://developer.pancakeswap.finance/contracts/{v2,v3}/addresses
export const BSC_SPOT = Object.freeze({
  ...BSC_PANCAKE,
  version: 'pancake-direct-spot-v1',
  v2Router: '0x10ed43c718714eb63d5aa57b78b54704e256024e' as const,
  v3Router: '0x1b81d678ffb9c0263b24a97847620c99d213eb14' as const,
  v3Quoter: '0xb048bbc1ee6b733fffcfb9e9cef7375518e25997' as const,
  v3Deployer: '0x41ff9aa7e16b8b1a8a8dc4f0efacd93d02d071c9' as const,
});
export const V3_FEES = Object.freeze([100, 500, 2500, 10_000]);
export const BSC_ERC20_ABI = parseAbi([
  'function decimals() view returns(uint8)',
  'function balanceOf(address) view returns(uint256)',
  'function allowance(address owner,address spender) view returns(uint256)',
  'function approve(address spender,uint256 amount) returns(bool)',
]);
export const BSC_POOL_ABI = parseAbi([
  'function factory() view returns(address)',
  'function token0() view returns(address)',
  'function token1() view returns(address)',
  'function fee() view returns(uint24)',
  'function getReserves() view returns(uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)',
  'function slot0() view returns(uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint32 feeProtocol,bool unlocked)',
]);
export const BSC_V2_ROUTER_ABI = parseAbi([
  'function factory() view returns(address)',
  'function WETH() view returns(address)',
  'function getAmountsOut(uint256 amountIn,address[] path) view returns(uint256[] amounts)',
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin,address[] path,address to,uint256 deadline) payable',
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline)',
]);
export const BSC_V3_ROUTER_ABI = parseAbi([
  'function factory() view returns(address)',
  'function WETH9() view returns(address)',
  'function deployer() view returns(address)',
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns(uint256 amountOut)',
  'function multicall(bytes[] data) payable returns(bytes[] results)',
  'function refundETH() payable',
  'function unwrapWETH9(uint256 amountMinimum,address recipient) payable',
]);
export const BSC_QUOTER_ABI = parseAbi([
  'function factory() view returns(address)',
  'function WETH9() view returns(address)',
  'function deployer() view returns(address)',
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
]);
