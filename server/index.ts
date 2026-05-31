import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import dotenv from 'dotenv';

dotenv.config({ path: '../.env' });

const fastify = Fastify({ logger: true });

fastify.register(cors);
fastify.register(websocket);

fastify.get('/health', async () => {
  return { status: 'ok', engine: 'DeepSeek V3.2' };
});

// Agent Chat Endpoint placeholder
fastify.post('/api/chat', async (request, reply) => {
  // AI SDK integration will go here
  return { message: 'Agent backend ready' };
});

const start = async () => {
  try {
    const port = process.env.PORT ? parseInt(process.env.PORT) : 3001;
    await fastify.listen({ port, host: '0.0.0.0' });
    console.log(`Server is running on http://localhost:${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
