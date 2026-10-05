import { Router } from 'express';
import type { Lang } from '@ots/contracts';
import { ErrorCode, badRequest, notFound } from '../errors.js';
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

  /**
   * 不翻译直接写库（DESIGN.md §5.2 的扩展，见 §9.1）：把用户输入的原样存成一条
   * 条目，target_text 与 source_text 相同、model_id 为空。适合记录无需翻译的
   * 注释/中间信息。
   */
  router.post('/entries', (req, res) => {
    const body = asRecord(req.body);
    const collectionId = body.collection_id;
    const text = body.text;
    const sourceLang: unknown = body.source_lang;
    const targetLang: unknown = body.target_lang;
    if (typeof collectionId !== 'string' || collectionId.trim() === '') {
      throw badRequest(ErrorCode.invalidRequest, 'collection_id 必须是非空字符串');
    }
    if (typeof text !== 'string' || text.trim() === '') {
      throw badRequest(ErrorCode.invalidRequest, 'text 必须是非空字符串');
    }
    if (sourceLang !== 'zh' && sourceLang !== 'en') {
      throw badRequest(ErrorCode.invalidRequest, 'source_lang 必须是 zh 或 en');
    }
    if (targetLang !== 'zh' && targetLang !== 'en') {
      throw badRequest(ErrorCode.invalidRequest, 'target_lang 必须是 zh 或 en');
    }
    const entry = collections.insertEntry({
      collectionId,
      sourceLang: sourceLang as Lang,
      targetLang: targetLang as Lang,
      sourceText: text,
      targetText: text,
      modelId: null,
    });
    res.status(201).json({ entry });
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
