import express from 'express';
import http from 'http';
import path from 'path';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { initDatabase } from './server/db.ts';
import { RealtimeHub } from './server/ws.ts';
import { createAuthRouter } from './server/routes/auth.ts';
import { createPublicRouter } from './server/routes/public.ts';
import { createClientRouter } from './server/routes/client.ts';
import { createPaymentsRouter } from './server/routes/payments.ts';
import { createCallsRouter } from './server/routes/calls.ts';
import { createProfessionalRouter } from './server/routes/professional.ts';
import { createAdminRouter } from './server/routes/admin.ts';

dotenv.config();

async function startServer() {
  const PORT = Number(process.env.PORT || 3000);
  const app = express();
  const server = http.createServer(app);

  app.set('trust proxy', 1);
  app.use(express.json({ limit: '2mb' }));

  const db = initDatabase();
  const hub = new RealtimeHub(server, db);

  // API Routes
  app.use('/api/auth', createAuthRouter(db));
  app.use('/api/public', createPublicRouter(db));
  app.use('/api/client', createClientRouter(db, hub));
  app.use('/api/payments', createPaymentsRouter(db, hub));
  app.use('/api/calls', createCallsRouter(db, hub));
  app.use('/api/professional', createProfessionalRouter(db));
  app.use('/api/admin', createAdminRouter(db, hub));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'aurum-prive' });
  });

  // Mount Vite middleware in development or serve static build in production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Aurum Privé server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
