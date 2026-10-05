/** 左栏：合集列表，支持新建、切换、重命名、删除（DESIGN.md §9.1）。 */

import { useState } from 'react';
import type { Collection } from '@ots/contracts';
import { formatDateTime } from '../format';

export interface CollectionListProps {
  collections: Collection[];
  activeId: string | null;
  loading: boolean;
  busy: boolean;
  onSelect: (id: string) => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (collection: Collection) => void;
}

export function CollectionList({
  collections,
  activeId,
  loading,
  busy,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: CollectionListProps): JSX.Element {
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

  const submitCreate = (): void => {
    onCreate(newName);
    setNewName('');
  };

  const startEditing = (collection: Collection): void => {
    setEditingId(collection.id);
    setEditingName(collection.name);
  };

  const commitEditing = (): void => {
    if (editingId === null) {
      return;
    }
    const name = editingName.trim();
    const current = collections.find((item) => item.id === editingId);
    if (name !== '' && current !== undefined && name !== current.name) {
      onRename(editingId, name);
    }
    setEditingId(null);
    setEditingName('');
  };

  return (
    <aside className="panel collections">
      <div className="panel-header">
        <h2>合集</h2>
        <span className="muted">共 {collections.length} 个</span>
      </div>

      <div className="create-row">
        <input
          className="input"
          type="text"
          value={newName}
          placeholder="新合集名称（可留空）"
          maxLength={80}
          disabled={busy}
          onChange={(event) => {
            setNewName(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              submitCreate();
            }
          }}
        />
        <button type="button" className="btn btn-primary" onClick={submitCreate} disabled={busy}>
          新建合集
        </button>
      </div>

      {loading && collections.length === 0 ? <p className="state">正在加载合集…</p> : null}
      {!loading && collections.length === 0 ? (
        <p className="state">还没有任何合集，输入名称后点击"新建合集"。</p>
      ) : null}

      <ul className="collection-items">
        {collections.map((collection) => {
          const isActive = collection.id === activeId;
          return (
            <li
              key={collection.id}
              className={isActive ? 'collection-item active' : 'collection-item'}
            >
              {editingId === collection.id ? (
                <input
                  className="input"
                  type="text"
                  value={editingName}
                  autoFocus
                  maxLength={80}
                  onChange={(event) => {
                    setEditingName(event.target.value);
                  }}
                  onBlur={commitEditing}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      commitEditing();
                    } else if (event.key === 'Escape') {
                      setEditingId(null);
                      setEditingName('');
                    }
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="collection-main"
                  onClick={() => {
                    if (!isActive) {
                      onSelect(collection.id);
                    }
                  }}
                  disabled={busy}
                  title={isActive ? '当前合集' : '切换到该合集'}
                >
                  <span className="collection-name">{collection.name}</span>
                  <span className="collection-meta muted">
                    {collection.entry_count} 条 · {formatDateTime(collection.updated_at)}
                  </span>
                </button>
              )}

              <div className="collection-actions">
                <button
                  type="button"
                  className="btn btn-mini"
                  onClick={() => {
                    startEditing(collection);
                  }}
                  disabled={busy}
                >
                  重命名
                </button>
                <button
                  type="button"
                  className="btn btn-mini btn-danger-outline"
                  onClick={() => {
                    onDelete(collection);
                  }}
                  disabled={busy}
                >
                  删除
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
