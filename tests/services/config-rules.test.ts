/**
 * 测试 - ConfigService 生成配置时注入已保存的分流规则（原生规则集适配）
 */
import { describe, it, expect } from 'vitest';
import { MemoryKvAdapter, createRepositories } from '@/storage/kv';
import { createConfigService } from '@/services/config.service';

describe('ConfigService 分流规则注入', () => {
  it('未保存规则时，mihomo 配置仍包含 base 规则（如 MATCH），且 native 固定规则自动注入', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const svc = createConfigService(repos, kv);

    const yaml = await svc.generate('mihomo');

    // 无用户保存规则时，native 固定规则（如 category-ads-all / cn / geoip,cn）会自动注入
    expect(yaml).toContain('MATCH'); // MATCH 兜底始终存在
    expect(yaml).toContain('GEOIP,lan,DIRECT,no-resolve'); // v2.11.0: 内网防代理拆两条，lan 在前
    expect(yaml).toContain('GEOSITE,private,DIRECT');
    // native 固定规则也会出现在输出中
    expect(yaml).toContain('GEOSITE,category-ads-all');
  });

  it('保存 googlefcm 规则后，mihomo 配置输出原生 GEOSITE 规则', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const svc = createConfigService(repos, kv);

    // 保存 googlefcm 规则（v2.11.6 起为 native 原生规则，走 GEOSITE 路径）
    await repos.settings.set('selected_rules', JSON.stringify(['googlefcm']));

    const yaml = await svc.generate('mihomo');

    // googlefcm 并入国内直连组（native → DIRECT，2026-09-19）：GEOSITE,googlefcm,DIRECT，不走 RULE-SET
    expect(yaml).toContain('GEOSITE,googlefcm,DIRECT');
    expect(yaml).not.toContain('RULE-SET,geosite-googlefcm');
  });

  it('不生成 rule-providers 块（全组原生化）', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const svc = createConfigService(repos, kv);

    const yaml = await svc.generate('mihomo');

    // 全组原生化后，不再输出 rule-providers
    expect(yaml).not.toContain('rule-providers');
  });
});
