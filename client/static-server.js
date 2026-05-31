import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const loadClientServerConf = () => {
  const defaults = {
    devPort: 5174,
    staticPort: 5174,
    host: '0.0.0.0',
    apiPort: 3001,
    wsPort: 3001,
    terminalPort: 3003,
  };

  try {
    const confPath = path.join(__dirname, 'server_conf.json');
    if (!fs.existsSync(confPath)) return defaults;
    const parsed = JSON.parse(fs.readFileSync(confPath, 'utf-8'));
    return {
      devPort: Number(parsed?.devPort) || defaults.devPort,
      staticPort: Number(parsed?.staticPort) || defaults.staticPort,
      host: String(parsed?.host || defaults.host),
      apiPort: Number(parsed?.apiPort) || defaults.apiPort,
      wsPort: Number(parsed?.wsPort) || defaults.wsPort,
      terminalPort: Number(parsed?.terminalPort) || defaults.terminalPort,
    };
  } catch {
    return defaults;
  }
};

const clientConf = loadClientServerConf();

const server = Fastify({ logger: true });

// 托管编译后的静态资源
server.register(fastifyStatic, {
  root: path.join(__dirname, 'dist'),
  prefix: '/', 
});

// 处理 SPA 路由：所有 404 回退到 index.html
server.setNotFoundHandler((request, reply) => {
  reply.sendFile('index.html');
});

const start = async () => {
  try {
    const port = clientConf.staticPort;
    const host = clientConf.host;
    await server.listen({ port, host });
    console.log(`Client static server is running on http://localhost:${port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
