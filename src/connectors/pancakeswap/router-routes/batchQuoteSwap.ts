/**
 * Batch Quote Swap Endpoint for PancakeSwap
 * Fetches multiple quotes in a single RPC call using Multicall3
 */

import { Contract, utils } from 'ethers';
import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginAsync } from 'fastify';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import { getEthereumChainConfig } from '../../../chains/ethereum/ethereum.config';
import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import { MulticallService, MulticallCall } from '../../../services/multicall-service';
import { Pancakeswap } from '../pancakeswap';
import {
    getPancakeswapV2RouterAddress,
    getPancakeswapV3QuoterV2ContractAddress,
    IPancakeswapV2Router02ABI,
} from '../pancakeswap.contracts';

// V3 Quoter V2 ABI for encoding quote calls
const QUOTER_V2_ABI = [
    {
        inputs: [
            {
                components: [
                    { internalType: 'address', name: 'tokenIn', type: 'address' },
                    { internalType: 'address', name: 'tokenOut', type: 'address' },
                    { internalType: 'uint256', name: 'amountIn', type: 'uint256' },
                    { internalType: 'uint24', name: 'fee', type: 'uint24' },
                    { internalType: 'uint160', name: 'sqrtPriceLimitX96', type: 'uint160' },
                ],
                internalType: 'struct IQuoterV2.QuoteExactInputSingleParams',
                name: 'params',
                type: 'tuple',
            },
        ],
        name: 'quoteExactInputSingle',
        outputs: [
            { internalType: 'uint256', name: 'amountOut', type: 'uint256' },
            { internalType: 'uint160', name: 'sqrtPriceX96After', type: 'uint160' },
            { internalType: 'uint32', name: 'initializedTicksCrossed', type: 'uint32' },
            { internalType: 'uint256', name: 'gasEstimate', type: 'uint256' },
        ],
        stateMutability: 'nonpayable',
        type: 'function',
    },
    {
        inputs: [
            {
                components: [
                    { internalType: 'address', name: 'tokenIn', type: 'address' },
                    { internalType: 'address', name: 'tokenOut', type: 'address' },
                    { internalType: 'uint256', name: 'amount', type: 'uint256' },
                    { internalType: 'uint24', name: 'fee', type: 'uint24' },
                    { internalType: 'uint160', name: 'sqrtPriceLimitX96', type: 'uint160' },
                ],
                internalType: 'struct IQuoterV2.QuoteExactOutputSingleParams',
                name: 'params',
                type: 'tuple',
            },
        ],
        name: 'quoteExactOutputSingle',
        outputs: [
            { internalType: 'uint256', name: 'amountIn', type: 'uint256' },
            { internalType: 'uint160', name: 'sqrtPriceX96After', type: 'uint160' },
            { internalType: 'uint32', name: 'initializedTicksCrossed', type: 'uint32' },
            { internalType: 'uint256', name: 'gasEstimate', type: 'uint256' },
        ],
        stateMutability: 'nonpayable',
        type: 'function',
    },
];

// Request/Response schemas
const BatchQuoteItem = Type.Object({
    baseToken: Type.String({ description: 'Base token symbol or address' }),
    quoteToken: Type.String({ description: 'Quote token symbol or address' }),
    amount: Type.Number({ description: 'Amount to quote' }),
    side: Type.Union([Type.Literal('BUY'), Type.Literal('SELL')], {
        description: 'Trade side: BUY or SELL',
    }),
    poolType: Type.Optional(
        Type.Union([Type.Literal('v2'), Type.Literal('v3')], {
            description: 'Pool type: v2 or v3 (defaults to v3)',
        }),
    ),
    fee: Type.Optional(
        Type.Number({
            description: 'V3 pool fee tier in bps (100, 500, 2500, 10000). Defaults to 2500 (0.25%)',
        }),
    ),
});

export const BatchQuoteSwapRequest = Type.Object({
    network: Type.Optional(Type.String({ description: 'Network name (e.g., bsc, mainnet)' })),
    quotes: Type.Array(BatchQuoteItem, {
        description: 'Array of quote requests to batch',
        minItems: 1,
        maxItems: 50,
    }),
});

const BatchQuoteResultItem = Type.Object({
    index: Type.Number({ description: 'Original index in request array' }),
    success: Type.Boolean({ description: 'Whether the quote succeeded' }),
    baseToken: Type.String({ description: 'Base token symbol' }),
    quoteToken: Type.String({ description: 'Quote token symbol' }),
    amountIn: Type.Optional(Type.Number({ description: 'Input amount' })),
    amountOut: Type.Optional(Type.Number({ description: 'Output amount' })),
    price: Type.Optional(Type.Number({ description: 'Price (amountOut / amountIn)' })),
    poolType: Type.Optional(Type.String({ description: 'Pool type used' })),
    error: Type.Optional(Type.String({ description: 'Error message if failed' })),
});

export const BatchQuoteSwapResponse = Type.Object({
    network: Type.String({ description: 'Network used' }),
    totalQuotes: Type.Number({ description: 'Total number of quotes requested' }),
    successCount: Type.Number({ description: 'Number of successful quotes' }),
    failedCount: Type.Number({ description: 'Number of failed quotes' }),
    quotes: Type.Array(BatchQuoteResultItem, { description: 'Array of quote results' }),
});

type BatchQuoteSwapRequestType = Static<typeof BatchQuoteSwapRequest>;
type BatchQuoteSwapResponseType = Static<typeof BatchQuoteSwapResponse>;
type BatchQuoteItemType = Static<typeof BatchQuoteItem>;

interface QuoteCallInfo {
    index: number;
    request: BatchQuoteItemType;
    poolType: 'v2' | 'v3';
    tokenInAddress: string;
    tokenOutAddress: string;
    tokenInSymbol: string;
    tokenOutSymbol: string;
    tokenInDecimals: number;
    tokenOutDecimals: number;
    amountRaw: string;
}

async function batchQuoteSwap(
    network: string,
    quotes: BatchQuoteItemType[],
): Promise<BatchQuoteSwapResponseType> {
    logger.info(`[batchQuoteSwap] Processing ${quotes.length} quotes on network: ${network}`);

    const ethereum = await Ethereum.getInstance(network);
    const pancakeswap = await Pancakeswap.getInstance(network);

    // Prepare quote call info
    const quoteCallInfos: QuoteCallInfo[] = [];

    for (let i = 0; i < quotes.length; i++) {
        const quote = quotes[i];
        const poolType = quote.poolType || 'v3';

        // Resolve tokens
        const baseTokenInfo = await ethereum.getToken(quote.baseToken);
        const quoteTokenInfo = await ethereum.getToken(quote.quoteToken);

        if (!baseTokenInfo || !quoteTokenInfo) {
            logger.warn(`[batchQuoteSwap] Token not found for quote ${i}: ${quote.baseToken} or ${quote.quoteToken}`);
            continue;
        }

        // Determine input/output based on side
        const exactIn = quote.side === 'SELL';
        const [tokenIn, tokenOut] = exactIn
            ? [baseTokenInfo, quoteTokenInfo]
            : [quoteTokenInfo, baseTokenInfo];

        // Convert amount to raw units
        const amountDecimals = exactIn ? tokenIn.decimals : tokenOut.decimals;
        const amountRaw = utils.parseUnits(quote.amount.toString(), amountDecimals).toString();

        quoteCallInfos.push({
            index: i,
            request: quote,
            poolType,
            tokenInAddress: tokenIn.address,
            tokenOutAddress: tokenOut.address,
            tokenInSymbol: tokenIn.symbol,
            tokenOutSymbol: tokenOut.symbol,
            tokenInDecimals: tokenIn.decimals,
            tokenOutDecimals: tokenOut.decimals,
            amountRaw,
        });
    }

    // Build multicall calls
    const calls: MulticallCall[] = [];
    const v2RouterAddress = getPancakeswapV2RouterAddress(network);
    const v3QuoterAddress = getPancakeswapV3QuoterV2ContractAddress(network);

    const v2RouterInterface = new utils.Interface(IPancakeswapV2Router02ABI.abi);
    const v3QuoterInterface = new utils.Interface(QUOTER_V2_ABI);

    for (const info of quoteCallInfos) {
        if (info.poolType === 'v2') {
            // V2 uses getAmountsOut / getAmountsIn
            const path = [info.tokenInAddress, info.tokenOutAddress];
            const exactIn = info.request.side === 'SELL';

            let callData: string;
            if (exactIn) {
                callData = v2RouterInterface.encodeFunctionData('getAmountsOut', [info.amountRaw, path]);
            } else {
                callData = v2RouterInterface.encodeFunctionData('getAmountsIn', [info.amountRaw, path]);
            }

            calls.push({
                target: v2RouterAddress,
                callData,
            });
        } else {
            // V3 uses Quoter V2
            const fee = info.request.fee || 2500; // Default to 0.25% fee tier
            const exactIn = info.request.side === 'SELL';

            let callData: string;
            if (exactIn) {
                callData = v3QuoterInterface.encodeFunctionData('quoteExactInputSingle', [
                    {
                        tokenIn: info.tokenInAddress,
                        tokenOut: info.tokenOutAddress,
                        amountIn: info.amountRaw,
                        fee,
                        sqrtPriceLimitX96: 0,
                    },
                ]);
            } else {
                callData = v3QuoterInterface.encodeFunctionData('quoteExactOutputSingle', [
                    {
                        tokenIn: info.tokenInAddress,
                        tokenOut: info.tokenOutAddress,
                        amount: info.amountRaw,
                        fee,
                        sqrtPriceLimitX96: 0,
                    },
                ]);
            }

            calls.push({
                target: v3QuoterAddress,
                callData,
            });
        }
    }

    // Execute multicall
    const multicall = new MulticallService(ethereum.provider);
    const results = await multicall.tryAggregate(calls, false);

    // Parse results
    const quoteResults: Static<typeof BatchQuoteResultItem>[] = [];
    let successCount = 0;
    let failedCount = 0;

    for (let i = 0; i < quoteCallInfos.length; i++) {
        const info = quoteCallInfos[i];
        const result = results[i];

        if (!result.success) {
            failedCount++;
            quoteResults.push({
                index: info.index,
                success: false,
                baseToken: info.request.baseToken,
                quoteToken: info.request.quoteToken,
                poolType: info.poolType,
                error: 'Quote call failed',
            });
            continue;
        }

        try {
            let amountOut: string;
            let amountIn: string;

            if (info.poolType === 'v2') {
                const exactIn = info.request.side === 'SELL';
                if (exactIn) {
                    const decoded = v2RouterInterface.decodeFunctionResult('getAmountsOut', result.returnData);
                    const amounts = decoded.amounts;
                    amountIn = info.amountRaw;
                    amountOut = amounts[amounts.length - 1].toString();
                } else {
                    const decoded = v2RouterInterface.decodeFunctionResult('getAmountsIn', result.returnData);
                    const amounts = decoded.amounts;
                    amountIn = amounts[0].toString();
                    amountOut = info.amountRaw;
                }
            } else {
                const exactIn = info.request.side === 'SELL';
                if (exactIn) {
                    const decoded = v3QuoterInterface.decodeFunctionResult('quoteExactInputSingle', result.returnData);
                    amountIn = info.amountRaw;
                    amountOut = decoded.amountOut.toString();
                } else {
                    const decoded = v3QuoterInterface.decodeFunctionResult('quoteExactOutputSingle', result.returnData);
                    amountIn = decoded.amountIn.toString();
                    amountOut = info.amountRaw;
                }
            }

            // Convert to human-readable amounts
            const amountInFloat = parseFloat(utils.formatUnits(amountIn, info.tokenInDecimals));
            const amountOutFloat = parseFloat(utils.formatUnits(amountOut, info.tokenOutDecimals));
            const price = amountOutFloat / amountInFloat;

            successCount++;
            quoteResults.push({
                index: info.index,
                success: true,
                baseToken: info.request.baseToken,
                quoteToken: info.request.quoteToken,
                amountIn: amountInFloat,
                amountOut: amountOutFloat,
                price,
                poolType: info.poolType,
            });
        } catch (decodeError: any) {
            failedCount++;
            quoteResults.push({
                index: info.index,
                success: false,
                baseToken: info.request.baseToken,
                quoteToken: info.request.quoteToken,
                poolType: info.poolType,
                error: `Failed to decode result: ${decodeError.message}`,
            });
        }
    }

    // Add failed token resolution entries
    for (let i = 0; i < quotes.length; i++) {
        const hasResult = quoteResults.some((r) => r.index === i);
        if (!hasResult) {
            failedCount++;
            quoteResults.push({
                index: i,
                success: false,
                baseToken: quotes[i].baseToken,
                quoteToken: quotes[i].quoteToken,
                error: 'Token not found',
            });
        }
    }

    // Sort by original index
    quoteResults.sort((a, b) => a.index - b.index);

    logger.info(`[batchQuoteSwap] Completed: ${successCount} success, ${failedCount} failed`);

    return {
        network,
        totalQuotes: quotes.length,
        successCount,
        failedCount,
        quotes: quoteResults,
    };
}

export { batchQuoteSwap };

export const batchQuoteSwapRoute: FastifyPluginAsync = async (fastify) => {
    const chainConfig = getEthereumChainConfig();

    fastify.post<{
        Body: BatchQuoteSwapRequestType;
        Reply: BatchQuoteSwapResponseType;
    }>(
        '/batch-quote',
        {
            schema: {
                description:
                    'Get multiple swap quotes in a single RPC call using Multicall3. ' +
                    'Supports both V2 and V3 pools. Useful for fetching quotes at different amounts.',
                tags: ['/connector/pancakeswap'],
                body: BatchQuoteSwapRequest,
                response: { 200: BatchQuoteSwapResponse },
            },
        },
        async (request) => {
            try {
                const { network = chainConfig.defaultNetwork, quotes } = request.body;

                if (!quotes || quotes.length === 0) {
                    throw httpErrors.badRequest('At least one quote request is required');
                }

                return await batchQuoteSwap(network, quotes);
            } catch (e: any) {
                if (e.statusCode) throw e;
                logger.error('Error getting batch quotes:', e);
                throw httpErrors.internalServerError(e.message || 'Internal server error');
            }
        },
    );
};

export default batchQuoteSwapRoute;
