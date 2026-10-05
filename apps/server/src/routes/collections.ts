import { Router } from 'express';
import type { CollectionService } from '../services/collectionService.js';
import { asRecord, optionalString, requiredString } from '../http/parse.js';

/**
 * 合集路由（DESIGN.md §5.1）。
 *
 * 路径写全（`/collections/...`）并挂在 `/api` 下。多个路由器共用同一个挂载点时，
 * 全路径可以避免"挂载点 + 相对路径"的歧义：`/collections/active` 一旦落进
 * `/collections/:id` 就会被当成 id 处理。
 */
export function createCollectionsRouter(collections: CollectionService): Router {
  const router = Router();

  router.get('/collections', (_req, res) => {
    res.json(collections.list());
  });

  router.post('/collections', (req, res) => {
    const body = req.body === undefined ? {} : asRecord(req.body);
    const name = optionalString(body, 'name');
    res.status(201).json(collections.create(name));
  });

  // 静态段必须注册在参数路由之前。
  router.get('/collections/active', (_req, res) => {
    res.json({ collection: collections.getActive() });
  });

  router.put('/collections/active', (req, res) => {
    const body = asRecord(req.body);
    const id = requiredString(body, 'id');
    res.json({ collection: collections.setActive(id) });
  });

  router.patch('/collections/:id', (req, res) => {
    const body = asRecord(req.body);
    const name = requiredString(body, 'name');
    res.json(collections.rename(req.params.id, name));
  });

  router.delete('/collections/:id', (req, res) => {
    // 返回删除后的新 active 合集；若删的正是 active，服务内部已自动回退（§5.1）。
    res.json({ collection: collections.delete(req.params.id) });
  });

  return router;
}
