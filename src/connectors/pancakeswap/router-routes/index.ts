import { FastifyPluginAsync } from 'fastify';

import batchQuoteSwapRoute from './batchQuoteSwap';
import executeQuoteRoute from './executeQuote';
import executeSwapRoute from './executeSwap';
import quoteSwapRoute from './quoteSwap';

export const pancakeswapRouterRoutes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(quoteSwapRoute);
  await fastify.register(batchQuoteSwapRoute);
  await fastify.register(executeQuoteRoute);
  await fastify.register(executeSwapRoute);
};

export default pancakeswapRouterRoutes;
