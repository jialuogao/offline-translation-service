import { Router } from 'express';
import { ErrorCode, notFound } from '../errors.js';
import type { CollectionService } from '../services/collectionService.js';
import { asRecord, optionalStringArray, parsePositiveInt } from '../http/parse.js';

/** 翻译历史路由（DESIGN.md §5.2）。 */
export function createEntriesRouter(collections: CollectionService): Router {
  const router = Router();

  router.get('/collections/:id/entries', (req, res) => {
    const page = parsePositiveInt(req.query.page, 1);
    const pageSize = parsePositiveInt(req.query.pageSize, 50);
    res.json(collections.listEntries(req.params.id, page, pageSize));
  });

  router.delete('/collections/:id/entries', (req, res) => {
    res.json({ deleted: collections.clearEntries(req.params.id) });
  });

  router.post('/entries/batch-delete', (req, res) => {
    const body = asRecord(req.body);
    const ids = optionalStringArray(body, 'ids');
    res.json({ deleted: collections.batchDeleteEntries(ids) });
  });

  router.delete('/entries/:id', (req, res) => {
    const deleted = collections.deleteEntry(req.params.id);
    if (!deleted) throw notFound(ErrorCode.entryNotFound, '条目不存在');
    res.status(204).end();
  });

  return router;
}
