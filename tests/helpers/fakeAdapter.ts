import type { ModelInfo } from '../../apps/server/src/lmstudio/adapter.js';

/**
 * 进程管理测试用的 adapter 替身：不产生任何网络请求，`isReachable` 由测试控制。
 * 形状与 `LMStudioAdapter` 兼容，可直接注入 `LMStudioProcessManager`。
 */
export interface FakeAdapter {
  isReachable(signal?: AbortSignal): Promise<boolean>;
  listModels(signal?: AbortSignal): Promise<string[]>;
  describeModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  resolveModel(explicit?: string, signal?: AbortSignal): Promise<string | null>;
  chatCompletion(): Promise<never>;
  loadModel(modelId: string, signal?: AbortSignal): Promise<boolean>;
  /** 测试控制面 */
  setReachable(value: boolean): void;
  setModels(models: ModelInfo[]): void;
  readonly loadCalls: string[];
}

export function createFakeAdapter(initial: {
  reachable?: boolean;
  models?: ModelInfo[];
  loadResult?: boolean;
} = {}): FakeAdapter {
  let reachable = initial.reachable ?? false;
  let models = initial.models ?? [{ id: 'fake-model', state: 'not-loaded' as const }];
  const loadResult = initial.loadResult ?? true;
  const loadCalls: string[] = [];

  return {
    async isReachable(): Promise<boolean> {
      return reachable;
    },
    async listModels(): Promise<string[]> {
      if (!reachable) throw new Error('unreachable');
      return models.map((model) => model.id);
    },
    async describeModels(): Promise<ModelInfo[]> {
      if (!reachable) throw new Error('unreachable');
      return models;
    },
    async resolveModel(): Promise<string | null> {
      return models[0]?.id ?? null;
    },
    async chatCompletion(): Promise<never> {
      throw new Error('not used in this test');
    },
    async loadModel(modelId: string): Promise<boolean> {
      loadCalls.push(modelId);
      // 真实端点每次成功 load 都会新建实例并把该模型标记为已加载，
      // 替身照此更新状态，便于断言"已驻留就不会再次 load"。
      models = models.map((model) =>
        model.id === modelId ? { ...model, state: 'loaded' as const } : model,
      );
      return loadResult;
    },
    setReachable(value: boolean): void {
      reachable = value;
    },
    setModels(next: ModelInfo[]): void {
      models = next;
    },
    get loadCalls(): string[] {
      return loadCalls;
    },
  };
}
