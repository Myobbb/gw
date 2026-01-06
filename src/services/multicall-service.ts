/**
 * Multicall Service for batching multiple read calls into a single RPC request
 * Uses Multicall3 contract which is deployed at the same address on all EVM chains
 */

import { Contract, providers, utils } from 'ethers';

import { logger } from './logger';

// Multicall3 is deployed at the same address on all major EVM chains
// See: https://www.multicall3.com/
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

export const MULTICALL3_ABI = [
    {
        inputs: [
            {
                components: [
                    { internalType: 'address', name: 'target', type: 'address' },
                    { internalType: 'bytes', name: 'callData', type: 'bytes' },
                ],
                internalType: 'struct Multicall3.Call[]',
                name: 'calls',
                type: 'tuple[]',
            },
        ],
        name: 'aggregate',
        outputs: [
            { internalType: 'uint256', name: 'blockNumber', type: 'uint256' },
            { internalType: 'bytes[]', name: 'returnData', type: 'bytes[]' },
        ],
        stateMutability: 'payable',
        type: 'function',
    },
    {
        inputs: [
            { internalType: 'bool', name: 'requireSuccess', type: 'bool' },
            {
                components: [
                    { internalType: 'address', name: 'target', type: 'address' },
                    { internalType: 'bytes', name: 'callData', type: 'bytes' },
                ],
                internalType: 'struct Multicall3.Call[]',
                name: 'calls',
                type: 'tuple[]',
            },
        ],
        name: 'tryAggregate',
        outputs: [
            {
                components: [
                    { internalType: 'bool', name: 'success', type: 'bool' },
                    { internalType: 'bytes', name: 'returnData', type: 'bytes' },
                ],
                internalType: 'struct Multicall3.Result[]',
                name: 'returnData',
                type: 'tuple[]',
            },
        ],
        stateMutability: 'payable',
        type: 'function',
    },
];

export interface MulticallCall {
    target: string;
    callData: string;
}

export interface MulticallResult {
    success: boolean;
    returnData: string;
}

/**
 * MulticallService provides a way to batch multiple contract read calls
 * into a single RPC request using the Multicall3 contract.
 */
export class MulticallService {
    private provider: providers.Provider;
    private multicallContract: Contract;

    constructor(provider: providers.Provider) {
        this.provider = provider;
        this.multicallContract = new Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);
    }

    /**
     * Execute multiple calls in a single RPC request
     * Uses tryAggregate which allows individual calls to fail without reverting the whole batch
     *
     * @param calls Array of {target, callData} objects
     * @param requireSuccess If true, reverts if any call fails
     * @returns Array of {success, returnData} results
     */
    async tryAggregate(calls: MulticallCall[], requireSuccess: boolean = false): Promise<MulticallResult[]> {
        if (calls.length === 0) {
            return [];
        }

        logger.info(`[MulticallService] Executing ${calls.length} calls via Multicall3`);

        try {
            const results = await this.multicallContract.tryAggregate(requireSuccess, calls);

            return results.map((result: any) => ({
                success: result.success,
                returnData: result.returnData,
            }));
        } catch (error: any) {
            logger.error(`[MulticallService] Error executing multicall: ${error.message}`);
            throw error;
        }
    }

    /**
     * Execute multiple calls in a single RPC request
     * Uses aggregate which reverts if any call fails
     *
     * @param calls Array of {target, callData} objects
     * @returns Object with blockNumber and array of returnData
     */
    async aggregate(calls: MulticallCall[]): Promise<{ blockNumber: number; returnData: string[] }> {
        if (calls.length === 0) {
            return { blockNumber: 0, returnData: [] };
        }

        logger.info(`[MulticallService] Executing ${calls.length} calls via Multicall3 (strict mode)`);

        try {
            const result = await this.multicallContract.aggregate(calls);

            return {
                blockNumber: result.blockNumber.toNumber(),
                returnData: result.returnData,
            };
        } catch (error: any) {
            logger.error(`[MulticallService] Error executing multicall: ${error.message}`);
            throw error;
        }
    }

    /**
     * Helper to encode a contract function call
     *
     * @param contractInterface The contract interface (ABI)
     * @param functionName The function name to call
     * @param args The function arguments
     * @returns Encoded calldata
     */
    static encodeCall(contractInterface: utils.Interface, functionName: string, args: any[]): string {
        return contractInterface.encodeFunctionData(functionName, args);
    }

    /**
     * Helper to decode contract function result
     *
     * @param contractInterface The contract interface (ABI)
     * @param functionName The function name that was called
     * @param returnData The raw return data
     * @returns Decoded result
     */
    static decodeResult(contractInterface: utils.Interface, functionName: string, returnData: string): any {
        return contractInterface.decodeFunctionResult(functionName, returnData);
    }
}
