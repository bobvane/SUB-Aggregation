import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryKvAdapter, createRepositories } from '@/storage/kv';
import { createSubscriptionService } from '@/services/subscription.service';

const NODE_LINK = 'vmess://eyJhZGQiOiJleGFtcGxlLmNvbSIsInBvcnQiOiI0NDMiLCJpZCI6IjExMTExMTExLTIyMjItMzMzMy00NDQ0LTU1NTU1NTU1NTU1NSIsIm5ldCI6IndzIiwidGxzIjoidGxzIn0=';

describe('订阅代理策略持久化', () => {
  let repos: ReturnType<typeof createRepositories>;
  let service: ReturnType<typeof createSubscriptionService>;

  beforeEach(() => {
    const kv = new MemoryKvAdapter();
    repos = createRepositories(kv);
    service = createSubscriptionService(
      repos,
      async () => NODE_LINK,
      async () => [],
      kv
    );
  });

  it('创建时默认 auto，可显式保存 on/off', async () => {
    const auto = await service.create('auto-sub', 'https://a.example.com/sub');
    expect(auto.useProxy).toBe('auto');

    const on = await service.create('on-sub', 'https://b.example.com/sub', 'on');
    expect(on.useProxy).toBe('on');
    expect((await service.getById(on.id))?.useProxy).toBe('on');
  });

  it('编辑订阅时更新代理策略', async () => {
    const sub = await service.create('sub', 'https://example.com/sub', 'on');
    const updated = await service.updateDetails(sub.id, { useProxy: 'off' });
    expect(updated?.useProxy).toBe('off');
    expect((await service.getById(sub.id))?.useProxy).toBe('off');
  });

  it('更新订阅时使用保存的策略抓取内容', async () => {
    const sub = await service.create('sub', 'https://example.com/sub', 'off');
    const choices: Array<string | undefined> = [];
    const result = await service.update(sub.id, async (_url, options) => {
      choices.push(options?.choice);
      return NODE_LINK;
    });

    expect(choices).toEqual(['off']);
    expect(result.subscription.useProxy).toBe('off');
  });
});
